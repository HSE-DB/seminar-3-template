const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseSchema, checkTheory } = require('./dbml_helpers.cjs');

const pair = (reference) => `
Table tenant as T {
  id int [pk]
}
Table item {
  id int [pk]
  tenant_id int
}
${reference}
`;

test('парсер принимает inline, короткие, длинные и обратные Ref', () => {
  const variants = [
    pair('Ref: item.tenant_id > T.id'),
    pair('Ref: T.id < item.tenant_id'),
    pair('Ref owns { T.id < item.tenant_id }'),
    pair('').replace('tenant_id int', 'tenant_id int [ref: > T.id]'),
  ];
  for (const source of variants) {
    const schema = parseSchema(source);
    schema.structure({ tenant: ['id'], item: ['tenant_id'] });
    schema.references();
    schema.many('item', 'tenant');
  }
});

test('комментарии и заметки не превращаются в таблицы и связи', () => {
  const schema = parseSchema(`${pair('Ref: item.tenant_id > T.id')}
    // Table fake { id int [pk] }
    /* Ref: item.id <> tenant.id */
    Note explanation { 'Table fake { id int } Ref: item.id <> tenant.id' }
  `);
  assert.equal(schema.tables.length, 2);
  assert.equal(schema.links.length, 1);
  schema.references();
});

test('пустые файлы, неверный синтаксис и ссылки на неизвестные столбцы отклоняются', () => {
  for (const source of ['', '// только комментарий', 'Table broken {', pair('Ref: item.missing > T.id')]) {
    assert.throws(() => parseSchema(source), /добавьте таблицы|ошибка DBML/);
  }
});

test('имена допускают регистр, пробелы, подчёркивания, # и BOM', () => {
  const schema = parseSchema('\uFEFFTable "Station_Personnel" {\n "#First Name" text [pk]\n }');
  schema.structure({ stationpersonnel: ['first_name'] });
});

test('составные PK, UNIQUE, алиасы и ссылки между схемами', () => {
  const schema = parseSchema(`
    Table geo.location as L {
      name text
      region text
      indexes { (name, region) [pk] }
    }
    Table fleet.vehicle {
      id int [pk]
      location text
      region text
    }
    Ref: fleet.vehicle.(location, region) > L.(name, region)
  `);
  schema.structure({ location: ['name', 'region'] }, { location: ['name', 'region'] });
  schema.references();
  schema.many('vehicle', 'location');
});

test('неполная ссылка на составной ключ и ссылка на неуникальный столбец отклоняются', () => {
  const schema = parseSchema(`
    Table parent {
      a int
      b int
      indexes { (a,b) [pk] }
    }
    Table child {
      id int [pk]
      a int [ref: > parent.a]
    }
  `);
  assert.throws(() => schema.references(), /PK или UNIQUE/);
});

test('для каждой таблицы требуется первичный ключ', () => {
  const schema = parseSchema('Table item {\n code text [unique]\n }');
  assert.throws(() => schema.structure({ item: ['code'] }), /первичный ключ/);
});

test('прямая M:N и уникальный FK вместо стороны N отклоняются', () => {
  assert.throws(() => parseSchema(pair('Ref: item.id <> T.id')).references(), /промежуточной таблицей/);
  const schema = parseSchema(pair('Ref: item.tenant_id > T.id').replace('tenant_id int', 'tenant_id int [unique]'));
  assert.throws(() => schema.many('item', 'tenant'), /несколько строк/);
});

const weak = (surrogate = false) => `
  Table owner {\n id int [pk]\n }
  Table component {
    ${surrogate ? 'id int [pk]' : ''}
    owner_id int [not null, ref: > owner.id]
    number int [not null]
    indexes { (owner_id, number) [${surrogate ? 'unique' : 'pk'}] }
  }
`;

test('слабая сущность допускает составной и суррогатный PK с UNIQUE', () => {
  for (const surrogate of [false, true]) {
    const schema = parseSchema(weak(surrogate));
    schema.structure({ component: ['number'] });
    schema.references();
    schema.weak('component', 'owner', 'number');
  }
});

test('слабая сущность требует владельца и локальную уникальность номера', () => {
  const variants = [
    weak(true).replace('number int [not null]', 'number int [not null, unique]'),
    weak(true).replace('not null, ref:', 'ref:'),
    weak(true).replace('indexes { (owner_id, number) [unique] }', ''),
  ];
  for (const source of variants) {
    assert.throws(() => parseSchema(source).weak('component', 'owner', 'number'),
      /в пределах владельца|обязательна|PK или UNIQUE/);
  }
});

test('M:N проверяется по участникам, независимо от имени промежуточной таблицы', () => {
  const source = `
    Table member {\n id int [pk]\n }
    Table club {\n id int [pk]\n }
    Table membership {
      member_id int [ref: > member.id]
      club_id int [ref: > club.id]
      joined date
      indexes { (member_id, club_id) [pk] }
    }
  `;
  const schema = parseSchema(source);
  schema.references();
  schema.bridge('member', 'club', ['joined']);
  const wrong = parseSchema(source.replace('(member_id, club_id) [pk]', 'member_id [pk]'));
  assert.throws(() => wrong.bridge('member', 'club'), /стороне N/);
});

test('подтипы допускают inline и внешние 1:1, а также уникальный FK с >', () => {
  const source = 'Table person {\n id int [pk]\n }\nTable employee {\n id int [pk]\n }';
  for (const variant of [
    `${source}\nRef: person.id - employee.id`,
    `${source}\nRef: employee.id > person.id`,
    source.replace('Table employee {\n id int [pk]', 'Table employee {\n id int [pk, ref: - person.id]'),
  ]) {
    const schema = parseSchema(variant);
    schema.references();
    schema.subtype('employee', 'person');
  }
  const wrong = parseSchema(pair('Ref: item.tenant_id > T.id'));
  assert.throws(() => wrong.subtype('item', 'tenant'), /несколько строк/);
});

test('объявление 1:1 без ограничения уникальности не заменяет UNIQUE', () => {
  const schema = parseSchema(pair('Ref: T.id - item.tenant_id'));
  assert.throws(() => schema.references(), /для связи 1:1/);
});

test('две роли требуют двух разных внешних ключей', () => {
  const schema = parseSchema(pair('Ref: item.tenant_id > T.id'));
  assert.throws(() => schema.many('item', 'tenant', 2), /нужно внешних ключей: 2/);
});

function theory(answers) {
  return `## Теоретические вопросы\n${answers.map((answer, i) => `### ${i + 1}. Вопрос\n\n${answer}\n`).join('\n')}
## Практические задания
### 1. Задача
Текст условия не является ответом.
`;
}

test('теория: три ответа, включая многострочные ответы со списками', () => {
  checkTheory(theory(['Ответ один.', '- Первая причина.\n- Вторая причина.', 'Ответ три.']));
});

test('теория: заглушки, комментарии, пустой или отсутствующий ответ не дают балл', () => {
  for (const answer of ['', '<!-- Ваш ответ -->', '(Вставьте свой ответ сюда)', 'TODO', '…']) {
    assert.throws(() => checkTheory(theory(['Первый ответ.', 'Второй ответ.', answer])), /Вопрос 3/);
  }
  assert.throws(() => checkTheory(theory(['Первый ответ.', 'Второй ответ.'])), /три заголовка/);
});
