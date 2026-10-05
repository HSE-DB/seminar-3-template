const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { ROOT, readSchema, checkTheory, isUnique } = require('./dbml_helpers.cjs');

test('theory', () => {
  checkTheory(readFileSync(join(ROOT, 'README.md'), 'utf8'));
});

test('library_structure', () => {
  readSchema('library_system.dbml').structure({
    Reader: ['ReaderNumber', 'FirstName', 'LastName', 'Address', 'Birthday'],
    Book: ['ISBN', 'Title', 'Year', 'Author', 'Number_of_pages'],
    Copy: ['CopyNumber', 'Position'],
    Publisher: ['Name', 'Address'],
    Category: ['CategoryName'],
  }, { Reader: ['ReaderNumber'], Book: ['ISBN'] });
});

test('library_relationships', () => {
  const schema = readSchema('library_system.dbml');
  schema.references();
  schema.many('Book', 'Publisher');
  schema.many('Category', 'Category');
  schema.weak('Copy', 'Book', 'CopyNumber');
  schema.bridge('Book', 'Category');
  schema.bridge('Reader', 'Copy', ['ReturnDate']);
});

test('train_structure', () => {
  readSchema('train_schedule.dbml').structure({
    City: ['Name', 'Region'],
    Station: ['Name', 'Tracks'],
    Train: ['TrainNr', 'Length'],
  }, { City: ['Name', 'Region'], Station: ['Name'], Train: ['TrainNr'] });
});

test('train_relationships', () => {
  const schema = readSchema('train_schedule.dbml');
  schema.references();
  schema.many('Station', 'City');
  schema.many('Train', 'Station', 2); // Start и End.
  const train = schema.table('Train');
  const station = schema.table('Station');
  const connected = schema.tables.filter((table) => table !== train && table !== station
    && schema.between(table, train).length && schema.between(table, station).length);
  assert.equal(connected.length, 1, 'Connected: нужна таблица с поездом и двумя станциями');
  const [trainLink] = schema.many(connected[0], train);
  const stationLinks = schema.many(connected[0], station, 2);
  // В тернарной связи 1:1:N поезд и любая из двух станций определяют вторую.
  for (const stationLink of stationLinks) {
    schema.key(connected[0], [...new Set([...trainLink.source, ...stationLink.source])]);
  }
  schema.field(connected[0], 'Departure');
  schema.field(connected[0], 'Arrival');
});

test('ambulance_structure', () => {
  readSchema('ambulance.dbml').structure({
    Station: ['StatNr', 'Name'],
    StationPersonnel: ['PersNr', 'Name'],
    Doctor: ['Rank', 'Area'],
    Caregiver: ['Qualification'],
    Room: ['RoomNr', 'Beds'],
    Patient: ['PatientNr', 'Name', 'Disease'],
  }, { Station: ['StatNr'], StationPersonnel: ['PersNr'], Patient: ['PatientNr'] });
});

test('ambulance_relationships', () => {
  const schema = readSchema('ambulance.dbml');
  schema.references();
  schema.many('StationPersonnel', 'Station');
  schema.subtype('Doctor', 'StationPersonnel');
  schema.subtype('Caregiver', 'StationPersonnel');
  schema.weak('Room', 'Station', 'RoomNr');
  schema.many('Patient', 'Doctor');
  if (schema.between('Patient', 'Room').length) {
    schema.many('Patient', 'Room');
    schema.field('Patient', 'from');
    schema.field('Patient', 'to');
  } else {
    // Допускаем отдельную таблицу Admission, сохраняя одну палату у пациента.
    const admissions = schema.tables.filter((table) => schema.between(table, 'Patient').length
      && schema.between(table, 'Room').length);
    assert.equal(admissions.length, 1, 'Admission: свяжите пациента с палатой и сохраните даты from/to');
    const admission = admissions[0];
    const patientLinks = schema.between(admission, 'Patient');
    assert.equal(patientLinks.length, 1, 'Admission: нужна одна ссылка на пациента');
    assert(isUnique(admission, patientLinks[0].source), 'Admission: у пациента должна быть одна палата');
    schema.many(admission, 'Room');
    schema.field(admission, 'from');
    schema.field(admission, 'to');
  }
});
