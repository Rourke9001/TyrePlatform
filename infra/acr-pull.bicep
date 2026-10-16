// The API identity's AcrPull grant, as a module of infra/platform.bicep.
// Both environments pull from staging's registry, so production's grant
// lands in rg-tyre-staging (ADR-0017, Registry). A resource-group template
// cannot write an extension resource into another group except through a
// module scoped to that group.
targetScope = 'resourceGroup'

@description('The registry both environments pull from (ADR-0017).')
param acrName string

@description('Principal id of the API managed identity.')
param principalId string

@description('Resource id of the API managed identity. Part of the assignment name, so staging keeps the grant it already has.')
param apiIdentityId string

// Azure built-in roles have the same GUIDs in every Entra tenant, so
// hardcoding them is safe and avoids a roleDefinitions lookup at deploy time.
var roleAcrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

resource acrPullForApi 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, apiIdentityId, roleAcrPull)
  scope: acr
  properties: {
    principalId: principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleAcrPull)
    principalType: 'ServicePrincipal'
  }
}
