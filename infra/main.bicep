// Staging environment for the TyrePlatform POC. Per ADR-0005, staging IS
// production for the BAC pilot; a prod environment is stamped from this same
// template when the first external tenant signs.
//
// Deployed at resource-group scope into rg-tyre-staging. The resource group,
// budget, container registry and Log Analytics workspace are deliberately
// outside Bicep: they predate it, and the registry and logs hold state that
// must survive an environment teardown.
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

@description('Object id of the deploying user, granted Key Vault Administrator so secrets can be written after deployment.')
param deployerObjectId string

@description('Developer machine IP allowed through the PG firewall for migrations and db-test.')
param devMachineIp string

var tags = {
  project: 'tyreplatform'
  env: env
}

// Built-in role definition ids (constant across tenants).
var roleKeyVaultAdministrator = '00482a5a-887f-4fb3-b363-3b7fe8e74483'
var roleKeyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'
var roleAcrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: 'log-tyre-${env}'
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: 'crtyre${env}'
}

// ---------------------------------------------------------------- storage --

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

// Inspection photos (FR: damage photos on readings). Private; the API issues
// SAS URLs - the PWA never gets account keys.
resource photosContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'photos'
  properties: { publicAccess: 'None' }
}

// -------------------------------------------------------------- key vault --

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

resource kvAdminForDeployer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, deployerObjectId, roleKeyVaultAdministrator)
  scope: kv
  properties: {
    principalId: deployerObjectId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleKeyVaultAdministrator)
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

// Placeholder image until CI pushes the first real build (phase 4); the
// registry wiring and identity are already in place so that switch is a
// template revision, not a redeploy.
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
        targetPort: 80
        allowInsecure: false
      }
      registries: [
        {
          server: acr.properties.loginServer
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
        }
      ]
      // Scale to zero: an idle POC costs nothing (ADR-0001). If the first
      // request of the morning proves too slow, minReplicas: 1 at a known
      // monthly cost is the documented fix.
      scale: { minReplicas: 0, maxReplicas: 2 }
    }
  }
  dependsOn: [ acrPullForApi ]
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
