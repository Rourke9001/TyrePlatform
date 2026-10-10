// The pipeline's half of an environment (U117, ADR-0017): the API container
// app only, applied on every release by .github/workflows/deploy.yml, so
// its secret binding and settings cannot drift from this file. Everything
// it references is owned by infra/platform.bicep. It writes no role
// assignment, which is what lets the Contributor deploy identity apply it.

@description('Region for everything that stores data (ADR-0002).')
param location string = 'southafricanorth'

param env string

// Required with no default: a template run without the release's image
// must fail, not revert the app to a placeholder (TYRE-79).
@description('Full image reference, tagged with the commit (crtyrestaging.azurecr.io/tyre-api:<sha>).')
param apiImage string

@description('<c|d><run_number>-<run_attempt>-<sha7>: unique per deploy, so a rollback never reuses a revision name.')
@minLength(1)
@maxLength(64)
param revisionSuffix string

// Production pulls from staging's registry (ADR-0017, Registry).
param acrName string = 'crtyre${env}'
param acrResourceGroup string = resourceGroup().name

// ADR-0016's six settings. All are public identifiers, not secrets.
param authDiscoveryUrl string
param authIssuer string
param authTenantId string
param authAudience string
param authClientId string
param authTenantClaim string

var tags = {
  project: 'tyreplatform'
  env: env
}

resource cae 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: 'cae-tyre-${env}'
}

resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: 'id-tyre-api-${env}'
}

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: 'kv-tyre-${env}'
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
  scope: resourceGroup(acrResourceGroup)
}

// platform.bicep's kvSecretsForApi must be live before this applies, or the
// database-url Key Vault reference fails revision activation with a
// permission error, not a missing secret (runbook, bring-up step 4).
resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-api-${env}'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${apiIdentity.id}': {} }
  }
  properties: {
    managedEnvironmentId: cae.id
    configuration: {
      // Single: a failed revision never takes traffic from the one serving.
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        // The Go API listens on 8080 (PORT default in api/cmd/api/main.go).
        targetPort: 8080
        allowInsecure: false
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: apiIdentity.id
        }
      ]
      secrets: [
        // Resolved from Key Vault by the API's managed identity: app_login's
        // credential never exists in this repo, CI or the app config.
        {
          name: 'database-url'
          keyVaultUrl: '${kv.properties.vaultUri}secrets/database-url'
          identity: apiIdentity.id
        }
      ]
    }
    template: {
      revisionSuffix: revisionSuffix
      containers: [
        {
          name: 'api'
          image: apiImage
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            // NFR-SEC-007's rate limit reads the caller's address this many
            // entries from the right of X-Forwarded-For. '1' matches the
            // ingress above being the only hop; adding any L7 hop in front
            // and leaving this stale collapses the limit into one bucket.
            { name: 'TRUSTED_PROXY_HOPS', value: '1' }
            { name: 'AUTH_DISCOVERY_URL', value: authDiscoveryUrl }
            { name: 'AUTH_ISSUER', value: authIssuer }
            { name: 'AUTH_TENANT_ID', value: authTenantId }
            { name: 'AUTH_AUDIENCE', value: authAudience }
            { name: 'AUTH_CLIENT_ID', value: authClientId }
            { name: 'AUTH_TENANT_CLAIM', value: authTenantClaim }
          ]
          // Startup and liveness on /healthz, so a database blip makes a
          // replica unready, never restarted; readiness on /readyz, which
          // pings the database (spec section 1). Its 3s timeout sits above
          // the handler's 2s ping budget.
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/healthz', port: 8080 }
              periodSeconds: 3
              failureThreshold: 10
            }
            {
              type: 'Liveness'
              httpGet: { path: '/healthz', port: 8080 }
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/readyz', port: 8080 }
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 3
            }
          ]
        }
      ]
      // Scale to zero: an idle POC costs nothing (ADR-0001). maxReplicas and
      // minReplicas both bound the submit rate limiter's per-process
      // counters; see ratelimit.go (TYRE-184 F7).
      scale: { minReplicas: 0, maxReplicas: 2 }
    }
  }
}

output apiFqdn string = api.properties.configuration.ingress.fqdn
output latestRevisionName string = api.properties.latestRevisionName
