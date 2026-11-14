const { JSONFilePreset } = require("lowdb/node");

const dbPromise = JSONFilePreset("data/db.json", {
  users: []
});

async function getDatabase() {
  return await dbPromise;
}

module.exports = { getDatabase };
