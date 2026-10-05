const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { Parser, isEndpointOneSide, isEndpointManySide } = require('@dbml/core');

const ROOT = resolve(__dirname, '..');
const normalize = (name) => name.toLowerCase().replace(/[\s_#]/g, '');
const sameColumns = (a, b) => a.length === b.length && a.every((name) => b.includes(name));

function primaryKeys(table) {
  const inline = table.fields.filter((field) => field.pk).map((field) => field.name);
  const indexes = table.indexes.filter((index) => index.pk).map(indexColumns);
  return inline.length ? [inline, ...indexes] : indexes;
}

function indexColumns(index) {
  // Индекс по выражению не заменяет ключ из столбцов схемы.
  return index.columns.every((column) => column.type === 'column')
    ? index.columns.map((column) => column.value) : [];
}

function uniqueKeys(table) {
  return [
    ...primaryKeys(table),
    ...table.fields.filter((field) => field.unique).map((field) => [field.name]),
    ...table.indexes.filter((index) => index.unique).map(indexColumns),
  ].filter((key) => key.length);
}

const hasKey = (table, columns) => uniqueKeys(table).some((key) => sameColumns(key, columns));
const isUnique = (table, columns) => uniqueKeys(table).some((key) => key.every((name) => columns.includes(name)));
const isRequired = (table, name) => table.fields.find((field) => field.name === name).not_null === true
  || primaryKeys(table).some((key) => key.includes(name));

class Schema {
  constructor(database) {
    this.tables = database.schemas.flatMap((schema) => schema.tables);
    this.links = database.schemas.flatMap((schema) => schema.refs).map((ref) => {
      const [a, b] = ref.endpoints;
      // Для 1:1 DBML считает второй endpoint внешним ключом, в том числе
      // после нормализации inline ref парсером.
      const [parent, child] = isEndpointOneSide(a.relation) ? [a, b] : [b, a];
      const lookup = (endpoint) => database.schemas
        .find((schema) => schema.name === (endpoint.schemaName || 'public'))
        ?.tables.find((table) => table.name === endpoint.tableName);
      return {
        parent: lookup(parent), child: lookup(child),
        target: parent.fieldNames, source: child.fieldNames,
        manyToMany: isEndpointManySide(a.relation) && isEndpointManySide(b.relation),
        oneToOne: isEndpointOneSide(a.relation) && isEndpointOneSide(b.relation),
      };
    });
  }

  table(name) {
    if (typeof name !== 'string') return name;
    const matches = this.tables.filter((table) => normalize(table.name) === normalize(name));
    assert.equal(matches.length, 1, `Нужна одна таблица ${name}; найдено ${matches.length}`);
    return matches[0];
  }

  field(table, name) {
    table = this.table(table);
    const fields = table.fields.filter((field) => normalize(field.name) === normalize(name));
    assert.equal(fields.length, 1, `${table.name}: нужен столбец ${name}`);
    return fields[0].name;
  }

  structure(entities, naturalKeys = {}) {
    for (const [name, attributes] of Object.entries(entities)) {
      attributes.forEach((attribute) => this.field(name, attribute));
    }
    for (const table of this.tables) {
      const keys = primaryKeys(table);
      assert.equal(keys.length, 1, `${table.name}: задайте один первичный ключ`);
      assert(keys[0].length > 0, `${table.name}: первичный ключ должен состоять из столбцов`);
      assert(keys[0].every((name) => table.fields.find((field) => field.name === name)?.not_null !== false),
        `${table.name}: первичный ключ не может быть nullable`);
    }
    for (const [name, attributes] of Object.entries(naturalKeys)) {
      this.key(name, attributes.map((attribute) => this.field(name, attribute)));
    }
  }

  key(table, columns) {
    table = this.table(table);
    assert(hasKey(table, columns), `${table.name}: нужен PK или UNIQUE (${columns.join(', ')})`);
  }

  references() {
    for (const link of this.links) {
      assert(!link.manyToMany, 'Замените связь <> промежуточной таблицей с внешними ключами');
      assert(link.parent && link.child, 'Внешний ключ ссылается на неизвестную таблицу');
      this.key(link.parent, link.target);
      assert.equal(link.source.length, link.target.length, 'Размеры внешнего ключа и ключа назначения различаются');
      if (link.oneToOne) {
        assert(isUnique(link.child, link.source), `${link.child.name}: для связи 1:1 нужен PK или UNIQUE на внешнем ключе`);
      }
    }
  }

  between(child, parent) {
    child = this.table(child);
    parent = this.table(parent);
    return this.links.filter((link) => !link.manyToMany && link.child === child && link.parent === parent);
  }

  many(child, parent, count = 1) {
    const links = this.between(child, parent);
    assert.equal(links.length, count, `${this.table(child).name} → ${this.table(parent).name}: нужно внешних ключей: ${count}`);
    for (const link of links) {
      assert(!link.oneToOne && !isUnique(link.child, link.source),
        `${link.child.name} → ${link.parent.name}: связь должна допускать несколько строк на стороне N`);
    }
    if (count > 1) {
      assert.equal(new Set(links.map((link) => [...link.source].sort().join('\0'))).size, count,
        'Разные роли связи должны использовать разные внешние ключи');
    }
    return links;
  }

  weak(child, parent, number) {
    const [link] = this.many(child, parent);
    const local = this.field(child, number);
    this.key(child, [...link.source, local]);
    assert(!isUnique(link.child, [local]), `${link.child.name}: ${number} уникален только в пределах владельца`);
    assert(link.source.every((name) => isRequired(link.child, name)),
      `${link.child.name}: ссылка на владельца обязательна (NOT NULL или часть PK)`);
  }

  bridge(left, right, attributes = [], uniquePair = true) {
    left = this.table(left);
    right = this.table(right);
    const matches = this.tables.filter((table) => table !== left && table !== right
      && this.between(table, left).length && this.between(table, right).length);
    assert.equal(matches.length, 1, `${left.name} ↔ ${right.name}: нужна отдельная промежуточная таблица`);
    const table = matches[0];
    const [a] = this.many(table, left);
    const [b] = this.many(table, right);
    assert(!sameColumns(a.source, b.source), `${table.name}: нужны разные внешние ключи для участников связи`);
    attributes.forEach((attribute) => this.field(table, attribute));
    if (uniquePair) this.key(table, [...new Set([...a.source, ...b.source])]);
    return table;
  }

  subtype(child, parent) {
    const links = this.between(child, parent);
    assert.equal(links.length, 1, `${child}: нужна ссылка на ${parent}`);
    const [link] = links;
    assert(isUnique(link.child, link.source), `${child}: один сотрудник не может иметь несколько строк одного подтипа`);
    assert(link.source.every((name) => isRequired(link.child, name)), `${child}: ссылка на ${parent} обязательна`);
  }
}

function parseSchema(content, filename = 'DBML') {
  let database;
  try {
    database = new Parser().parse(content.replace(/^\uFEFF/, ''), 'dbmlv2');
  } catch (error) {
    const details = (error.diags || []).map((diag) =>
      `строка ${diag.location?.start?.line ?? '?'}: ${diag.message}`).join('; ');
    assert.fail(`${filename}: ошибка DBML: ${details || error.message}`);
  }
  const schema = new Schema(database);
  assert(schema.tables.length > 0, `${filename}: добавьте таблицы в схему`);
  return schema;
}

function readSchema(filename) {
  return parseSchema(readFileSync(resolve(ROOT, 'src', filename), 'utf8'), filename);
}

function checkTheory(markdown) {
  const text = markdown.replace(/<!--[\s\S]*?-->/g, '');
  const theory = text.match(/^## Теоретические вопросы\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m);
  assert(theory, 'Сохраните раздел «Теоретические вопросы» в корневом README');
  const questions = [...theory[1].matchAll(/^### ([123])\. [^\n]+\n([\s\S]*?)(?=^### |$(?![\s\S]))/gm)];
  assert.deepEqual(questions.map((match) => match[1]), ['1', '2', '3'], 'Сохраните три заголовка вопросов в README');
  for (const [, number, answer] of questions) {
    const visible = answer.replace(/\(?(?:вставьте свой ответ сюда|ваш ответ|TODO|TBD)\)?/gi, '').trim();
    assert(/\p{L}/u.test(visible), `Вопрос ${number}: напишите ответ вместо заглушки`);
  }
}

module.exports = { ROOT, parseSchema, readSchema, checkTheory, primaryKeys, uniqueKeys, hasKey, isUnique };
