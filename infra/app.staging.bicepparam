// Staging's values for infra/app.bicep. Every literal here is a public
// identifier (Confluence 10682399, Identity). The image and suffix come from
// the deploy job's environment, so a hand run without them fails.
using './app.bicep'

param env = 'staging'
param apiImage = readEnvironmentVariable('API_IMAGE')
param revisionSuffix = readEnvironmentVariable('REVISION_SUFFIX')

param authDiscoveryUrl = 'https://9f571f6c-5e2c-42ad-9cc2-e173ef4a0c19.ciamlogin.com/9f571f6c-5e2c-42ad-9cc2-e173ef4a0c19/v2.0/.well-known/openid-configuration?appid=7804c37b-de70-4e9d-8700-f7f7a70fc988'
param authIssuer = 'https://9f571f6c-5e2c-42ad-9cc2-e173ef4a0c19.ciamlogin.com/9f571f6c-5e2c-42ad-9cc2-e173ef4a0c19/v2.0'
param authTenantId = '9f571f6c-5e2c-42ad-9cc2-e173ef4a0c19'
param authAudience = '7804c37b-de70-4e9d-8700-f7f7a70fc988'
param authClientId = '15552f43-eb78-438b-9c3d-809c5024e25e'
param authTenantClaim = 'platformTenantId'
