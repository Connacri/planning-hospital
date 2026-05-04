const fs = require('fs');
const MDBReader = require('mdb-reader').default;

// Charger MDB
const buffer = fs.readFileSync('./data.mdb');

// Initialiser lecteur
const reader = new MDBReader(buffer);

// Voir les tables
console.log("📋 Tables disponibles :");
console.log(reader.getTableNames());

// ⚠️ remplace par le bon nom après affichage
const table = reader.getTable('agents');

// Lire données
const rows = table.getData();

console.log(`\n📦 ${rows.length} enregistrements\n`);

// Voir structure réelle
console.log("🔍 Exemple ligne :");
console.log(rows[0]);

// Affichage simple
rows.forEach((row, i) => {
  console.log(`\n--- Staff ${i + 1} ---`);
  console.log(row);
});