// Staging environment for the TyrePlatform POC. Per ADR-0005, staging IS
// production for the BAC pilot; a prod environment is stamped from this same
// template when the first external tenant signs.
//
// Deployed at resource-group scope into rg-tyre-staging. Deliberately outside
// Bicep: the resource group (this template's own scope), the budget (guards
// the subscription, not one environment), the registry and Log Analytics
// workspace (state that must survive an environment teardown), and the deploy
// identity id-tyre-deploy-staging with its role assignments — it is the
// credential that runs this template, so the template cannot own it.
//
// ACCEPTED TRADE: id-tyre-deploy-staging's Contributor scope on
// rg-tyre-staging is therefore live-Azure only, not visible or reviewable
// here. Accepted for a single-operator subscription, where the actual
// enforcement boundary is RLS plus password auth (non-negotiable rule 1),
// not Azure RBAC scoping. Revisit before the first commercial contract, per
// NFR-SEC-014; tracked as TYRE-61.
//
// Deploy: az deployment group create -g rg-tyre-staging -f infra/main.bicep \
//           -p pgAdminPassword=... deployerObjectId=... devMachineIp=...

@description('Region for everything that stores data (ADR-0002).')
param location string = 'southafricanorth'

// Static Web Apps has no South Africa region (ADR-0002). The SWA serves only
// the compiled frontend from a global CDN - no personal information at rest.
param swaLocation string = 'westeurope'

param env string = 'staging'

@secure()
@description('PostgreSQL admin password. Migrations-only credential: the API connects as app_login, never as this admin - RLS does not bind superusers (non-negotiable rule 1).')
param pgAdminPassword string

@description('Object id of the deploying user, granted Key Vault Secrets Officer so secrets can be written after deployment.')
param deployerObjectId string

@description('Developer machine IP allowed through the PG firewall for migrations and db-test.')
param devMachineIp string

var tags = {
  project: 'tyreplatform'
  env: env
}

// Azure built-in roles have the same GUIDs in every Entra tenant, so
// hardcoding them is safe and avoids a roleDefinitions lookup at deploy time.
var roleKeyVaultSecretsOfficer = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
var roleKeyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'
var roleAcrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: 'log-tyre-${env}'
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: 'crtyre${env}'
}

// ---------------------------------------------------------------- storage --

// ACCEPTED TRADE (POC, no VNet exists): no publicNetworkAccess or
// networkAcls is set, so this account answers on its public endpoint.
// allowBlobPublicAccess: false below is the compensating control. Revisit
// before the first commercial contract, per NFR-SEC-014; tracked as
// TYRE-61.
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'sttyre${env}'
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    accessTier: 'Hot'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

// Inspection photos (FR-INS-023/024: photos and damage observations per
// position). Private; the API issues SAS URLs - the PWA never gets account
// keys.
resource photosContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'photos'
  properties: { publicAccess: 'None' }
}

// -------------------------------------------------------------- key vault --

// ACCEPTED TRADE (POC, no VNet exists): no publicNetworkAccess or
// networkAcls is set, so this vault answers on its public endpoint.
// enableRbacAuthorization above is the actual boundary. Revisit before the
// first commercial contract, per NFR-SEC-014; tracked as TYRE-61.
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-tyre-${env}'
  location: location
  tags: tags
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: tenant().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
  }
}

// Secrets Officer, not Administrator: the deploying human only needs to
// write secrets post-deploy (see the database-url secret set command
// below), not manage the vault's own access policies. This assignment does
// not remove the Key Vault Administrator role already granted to this
// principal on the live vault; that removal is a manual Azure step
// (TYRE-63).
resource kvSecretsOfficerForDeployer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, deployerObjectId, roleKeyVaultSecretsOfficer)
  scope: kv
  properties: {
    principalId: deployerObjectId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleKeyVaultSecretsOfficer)
    principalType: 'User'
  }
}

// ------------------------------------------------------- managed identity --

resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-tyre-api-${env}'
  location: location
  tags: tags
}

resource acrPullForApi 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, apiIdentity.id, roleAcrPull)
  scope: acr
  properties: {
    principalId: apiIdentity.properties.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleAcrPull)
    principalType: 'ServicePrincipal'
  }
}

resource kvSecretsForApi 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, apiIdentity.id, roleKeyVaultSecretsUser)
  scope: kv
  properties: {
    principalId: apiIdentity.properties.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleKeyVaultSecretsUser)
    principalType: 'ServicePrincipal'
  }
}

// ----------------------------------------------------------------- postgres --

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: 'psql-tyre-${env}'
  location: location
  tags: tags
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: 'tyreadmin'
    administratorLoginPassword: pgAdminPassword
    // Password auth stays enabled: the whole RLS model runs on database
    // roles (app_login + SET LOCAL app.tenant_id). Entra-only auth would
    // break it (non-negotiable rule 1).
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
  }
}

// ACCEPTED TRADE (until a VNet exists): 0.0.0.0 admits any Azure-hosted
// client, not just ours. Consumption Container Apps have no stable egress
// IP without VNet integration, which is deliberate POC scope-out. RLS and
// password auth are the actual boundary; revisit at first external tenant.
resource pgAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: pg
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource pgAllowDev 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: pg
  name: 'AllowDevMachine'
  properties: { startIpAddress: devMachineIp, endIpAddress: devMachineIp }
}

resource tyreDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: 'tyre'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

// ---------------------------------------------------------- container apps --

resource cae 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-tyre-${env}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

// ACCEPTED TRADE: the image below is a placeholder. From the first CI deploy
// onward the live image is owned by .github/workflows/deploy.yml (tagged with
// the git sha), so a full template redeploy silently reverts the app to the
// placeholder. Compensating control: redeploy the template only alongside a
// CI run, which immediately re-deploys the real image.
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
        // Resolved from Key Vault by the API's managed identity, so the
        // app_login credential never exists in this repo, CI, or the app's
        // configuration — only in kv-tyre-staging. The secret must exist
        // before this template deploys or revision activation fails:
        //   az keyvault secret set --vault-name kv-tyre-staging \
        //     --name database-url --value 'postgres://app_login:...'
        {
          name: 'database-url'
          keyVaultUrl: '${kv.properties.vaultUri}secrets/database-url'
          identity: apiIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: 'mcr.microsoft.com/k8se/quickstart:latest'
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            // NFR-SEC-007's per-source-address rate limit reads the caller's
            // address this many entries from the right of X-Forwarded-For,
            // trusting that many hops to have appended their own observation
            // rather than relayed the caller's claim untouched. '1' matches
            // the ingress above being the only hop between the caller and
            // this container. Putting any additional L7 hop in front of it —
            // Front Door, Application Gateway, a CDN, a WAF — moves the
            // trustworthy entry further from the right; leaving this stale
            // after doing so collapses the address limit into one bucket
            // shared by every client on the internet.
            { name: 'TRUSTED_PROXY_HOPS', value: '1' }
          ]
        }
      ]
      // Scale to zero: an idle POC costs nothing (ADR-0001). If the first
      // request of the morning proves too slow, minReplicas: 1 at a known
      // monthly cost is the documented fix.
      scale: { minReplicas: 0, maxReplicas: 2 }
    }
  }
  // kvSecretsForApi must exist first or the database-url Key Vault reference
  // fails revision activation with a permission error, not a missing secret.
  dependsOn: [ acrPullForApi, kvSecretsForApi ]
}

// -------------------------------------------------------- static web app --

resource swa 'Microsoft.Web/staticSites@2023-12-01' = {
  name: 'stapp-tyre-${env}'
  location: swaLocation
  tags: tags
  sku: { name: 'Free', tier: 'Free' }
  properties: {
    stagingEnvironmentPolicy: 'Enabled'
    allowConfigFileUpdates: true
  }
}

// ----------------------------------------------------------------- outputs --

output apiFqdn string = api.properties.configuration.ingress.fqdn
output pgFqdn string = pg.properties.fullyQualifiedDomainName
output swaHostname string = swa.properties.defaultHostname
output kvUri string = kv.properties.vaultUri
output blobEndpoint string = storage.properties.primaryEndpoints.blob
output apiIdentityClientId string = apiIdentity.properties.clientId
