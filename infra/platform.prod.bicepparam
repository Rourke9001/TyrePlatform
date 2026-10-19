// Production's values for infra/platform.bicep, committed so the what-if and
// the apply read the same reviewed file and no backup choice is typed by
// hand (NFR-MNT-007). The apply supplies the three environment variables, so
// a hand run without them fails rather than sending an empty password.
using './platform.bicep'

param env = 'prod'
param pgAdminPassword = readEnvironmentVariable('PG_ADMIN_PASSWORD')
param deployerObjectId = readEnvironmentVariable('DEPLOYER_OBJECT_ID')
param devMachineIp = readEnvironmentVariable('DEV_MACHINE_IP')

param backupRetentionDays = 30

// Fixed when the server is created; changing it later means rebuilding the
// server (runbook, Production bring-up step 3).
param geoRedundantBackup = 'Enabled'

// Sunday 00:00 UTC is 02:00 SAST, outside NFR-AVL-003's 06:00 to 18:00.
// azure-cli maps Sunday to dayOfWeek 0 for this API.
param pgMaintenanceWindow = { customWindow: 'Enabled', dayOfWeek: 0, startHour: 0, startMinute: 0 }

param lockData = true
