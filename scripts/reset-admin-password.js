var path = require('path');
var fs = require('fs');
var web = require('../server/lib/web');

var adminData = web.hashPassword('admin');
console.log('Hashed for "admin":', JSON.stringify(adminData));

var localPath = path.join(__dirname, '..', 'server', 'data', 'admin.json');
fs.writeFileSync(localPath, JSON.stringify(adminData));
console.log('Local admin.json updated.');

var configPath = path.join(__dirname, '..', 'firebase-applet-config.json');
if (fs.existsSync(configPath)) {
  try {
    var appConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (appConfig.projectId) {
      var Firestore = require('@google-cloud/firestore').Firestore;
      var dbOptions = { projectId: appConfig.projectId };
      if (appConfig.firestoreDatabaseId) {
        dbOptions.databaseId = appConfig.firestoreDatabaseId;
      }
      var firestore = new Firestore(dbOptions);
      firestore.collection('system').doc('admin').set(adminData).then(function() {
        console.log('Firestore system/admin updated successfully with exact web.hashPassword hash.');
        process.exit(0);
      }).catch(function(err) {
        console.error('Failed to update Firestore:', err.message);
        process.exit(0);
      });
    }
  } catch(e) {
    console.error('Error resetting firestore admin:', e.message);
  }
}
