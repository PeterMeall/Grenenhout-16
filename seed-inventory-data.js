// Initial data for the "Inventory" tab — what's in the OLD house, room by
// room, and whether it's coming to Grenenhout 16 or being left behind.
// Only used the very first time the "invRooms" collection in Firestore is
// found empty; after that everything lives in Firestore and this file is
// never read again. decision is "take", "leave", or null (undecided).

function mk(prefix, rows) {
  return rows.map(function (row, i) {
    return { id: prefix + "-" + i, text: row[0], decision: row[1] };
  });
}

export const SEED_INV_ROOMS = [
  {
    id: "inv-living-room",
    name: "Living room",
    order: 0,
    items: mk("living", [
      ["TV", "take"],
      ["Bank + kussens", "take"],
      ["Plant (boom) en pot", "take"],
      ["Soundbar", "take"],
      ["Koffietafel", "take"],
      ["Mand met dekens", "take"],
      ["Vloerkleed", "take"],
      ["Twee kleine plantjes", "take"],
      ["Lounge stoel", "take"],
      ["Groot bankje", "take"],
      ["Plant en pot", "take"],
      ["Alle dozen nieuwe spullen", "take"],
      ["Piano en kruk", "take"],
      ["IKEA kasten met inhoud (waaronder servies)", "take"],
      ["Inhoud servies kast", "take"],
      ["Kleine witte spot", "take"],
      ["Gordijnen", "leave"],
      ["Hanglampen", "leave"],
      ["Vitrinekast", "leave"],
      ["TV-meubel", "leave"],
      ["Tafel", "leave"],
      ["Eetkamer stoelen", "leave"],
      ["Klein bankje", "leave"],
      ["Spiegel", "leave"],
      ["Bijzettafel", "leave"]
    ])
  },
  {
    id: "inv-kitchen",
    name: "Kitchen",
    order: 1,
    items: mk("kitchen", [
      ["Inhoud kastjes (6 dozen ish)", "take"],
      ["Koffie machine", "take"],
      ["Verlichting", "take"],
      ["Prullenbak", "leave"]
    ])
  },
  {
    id: "inv-hallway",
    name: "Hallway",
    order: 2,
    items: mk("hallway", [
      ["Kerstkrans", "take"],
      ["Inhoud meterkast", "take"],
      ["Kapstok", "leave"],
      ["Rek sleutels", "leave"],
      ["Fotolijstjes", "leave"],
      ["Rechthoekige spiegel", "leave"]
    ])
  },
  {
    id: "inv-berging",
    name: "Berging",
    order: 3,
    items: mk("berging", [
      ["Wasmachine", "take"],
      ["Droger", "take"],
      ["Strijkplank", "take"],
      ["Strijkijzer", "take"],
      ["Tuinkussens", "take"],
      ["Apparatuur (kitchen aid/airfryer)", "take"],
      ["Ladder", "take"],
      ["Kerstspullen", "take"],
      ["Luchtbed", "take"],
      ["Tools", "take"],
      ["Vazen", "take"],
      ["Stellingkast", "leave"],
      ["Droogrekken", "leave"],
      ["Stofzuiger", "leave"]
    ])
  },
  {
    id: "inv-slaapkamer",
    name: "Slaapkamer",
    order: 4,
    items: mk("slaapkamer", [
      ["Tv", "take"],
      ["Matras", "take"],
      ["3x wandplankjes", "take"],
      ["Wasmand (inklappen)", "take"],
      ["Plant in pot", "take"],
      ["Sokkel", "take"],
      ["Lamp?", "take"],
      ["Robot stofzuiger", "take"],
      ["Inhoud klerenkasten/ladekasten/bed", "take"],
      ["Klerenkasten", "leave"],
      ["Ladekast", "leave"],
      ["Nachtkastjes", "leave"],
      ["Bedframe", "leave"],
      ["Spiegelgordijn", "leave"]
    ])
  },
  {
    id: "inv-badkamer",
    name: "Badkamer",
    order: 5,
    items: mk("badkamer", [
      ["Inhoud badkamerkastje", "take"],
      ["Badkamerkast", "leave"]
    ])
  },
  {
    id: "inv-balkon",
    name: "Balkon",
    order: 6,
    items: mk("balkon", [
      ["Plantenbakken (zonder aarde)", "take"],
      ["Buitenkleed", "take"],
      ["Bank", "take"]
    ])
  }
];
