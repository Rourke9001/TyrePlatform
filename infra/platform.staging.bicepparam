// Staging's values for infra/platform.bicep: the template's defaults
// (ADR-0017). The apply supplies the three environment variables, so a hand
// run without them fails rather than sending an empty password.
using './platform.bicep'

param env = 'staging'
param pgAdminPassword = readEnvironmentVariable('PG_ADMIN_PASSWORD')
param deployerObjectId = readEnvironmentVariable('DEPLOYER_OBJECT_ID')
param devMachineIp = readEnvironmentVariable('DEV_MACHINE_IP')
