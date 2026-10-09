// The rarely-changing half of an environment (U117, ADR-0017): identities,
// role assignments, data stores and the Container Apps environment. The
// owner applies it by hand (docs/runbooks/environment-release.md, bring-up
// step 4), because Contributor cannot write role assignments and the deploy
// identity holds Contributor. infra/app.bicep is the pipeline's half.
//
// Deployed at resource-group scope into rg-tyre-<env>. Outside Bicep: the
// resource group itself, the budget, the registry, Log Analytics, and the
// deploy identity id-tyre-deploy-staging, the credential the pipeline
// applies infra/app.bicep with.
//
// ACCEPTED TRADE: id-tyre-deploy-staging's Contributor scope on
// rg-tyre-staging is therefore live-Azure only, not visible or reviewable
// here. Accepted for a single-operator subscription, where the actual
// enforcement boundary is RLS plus password auth (non-negotiable rule 1),
// not Azure RBAC scoping. Revisit before the first commercial contract, per
// NFR-SEC-014; tracked as TYRE-61.
//
// Every apply re-sends pgAdminPassword read from kv-tyre-<env> and
// devMachineIp read live: a different password changes the admin's, and a
// stale IP moves the firewall rule (spec section 4).

@description('Region for everything that stores data (ADR-0002).')
param location string = 'southafricanorth'

// Static Web Apps has no South Africa region (ADR-0002). The SWA serves only
// the compiled frontend from a global CDN. No personal information at rest.
param swaLocation string = 'westeurope'

param env string = 'staging'

@secure()
@description('PostgreSQL admin password. Used for migrations and for the provisioning runbook (docs/runbooks/provision-a-user.md). The API connects as app_login, never as this admin: RLS does not bind it (non-negotiable rule 1).')
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
// position). Private; the API issues SAS URLs, so the PWA never gets account
// keys.
resource photosContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'photos'
  properties: { publicAccess: 'None' }
}

// -------------------------------------------------------------- key vault --

// ACCEPTED TRADE, same as storage above (no VNet, TYRE-61, NFR-SEC-014):
// enableRbacAuthorization is this vault's compensating control.
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

// Secrets Officer, not Administrator: the deploying human only writes
// secrets post-deploy, not the vault's own access policies. Does not
// remove the Key Vault Administrator role already granted on the live
// vault; that removal is a manual step (TYRE-63).
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

// ACCEPTED TRADE, same as storage/KV above (no VNet, TYRE-61): Consumption
// Container Apps have no stable egress IP without VNet integration, so RLS
// and password auth are the actual boundary here too.
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

// Flexible Server refuses CREATE EXTENSION for anything not allow-listed
// here, and 000026 needs btree_gist (TYRE-368). The parameter is dynamic:
// no restart. Serialised after the server's other children, which can
// conflict when ARM applies them in parallel.
resource pgExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: pg
  name: 'azure.extensions'
  properties: {
    value: 'PGCRYPTO,BTREE_GIST'
    source: 'user-override'
  }
  dependsOn: [ pgAllowAzure, pgAllowDev, tyreDb ]
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

output pgFqdn string = pg.properties.fullyQualifiedDomainName
output swaHostname string = swa.properties.defaultHostname
output kvUri string = kv.properties.vaultUri
output blobEndpoint string = storage.properties.primaryEndpoints.blob
output apiIdentityClientId string = apiIdentity.properties.clientId
