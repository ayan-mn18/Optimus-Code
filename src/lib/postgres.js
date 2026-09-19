import pg from 'pg';
import { env } from '../config/env.js';

const { Pool } = pg;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdentifier(value) {
  if (!IDENTIFIER.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}

function tableIdentifier(table) {
  return `"public".${quoteIdentifier(table)}`;
}

function splitTopLevel(value) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = value.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function parseFields(fields = '*') {
  const raw = String(fields).trim();
  if (raw === '*' || raw === '') return { columns: ['*'], relations: [] };

  const columns = [];
  const relations = [];
  for (const item of splitTopLevel(raw)) {
    const relation = item.match(/^([A-Za-z_][A-Za-z0-9_]*):([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/s);
    if (relation) {
      relations.push({ alias: relation[1], table: relation[2], fields: relation[3] || '*' });
    } else {
      columns.push(item.trim());
    }
  }
  return { columns: columns.length ? columns : ['*'], relations };
}

function parseColumn(value) {
  const column = String(value).trim();
  if (!IDENTIFIER.test(column)) throw new Error(`Unsafe SQL column: ${column}`);
  return quoteIdentifier(column);
}

function relationForeignKey(table, alias) {
  // The live Optimus schema currently exposes this PostgREST relation.
  // Keep it explicit until the native adapter is replaced by generated SQL.
  if (table === 'problems' && alias === 'problem') return 'problem_id';
  return `${alias}_id`;
}

function sqlLike(value) {
  return String(value).replace(/\*/g, '%');
}

function toError(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    code: error?.code ?? 'PG_ERROR',
    details: error?.detail,
    hint: error?.hint,
  };
}

const RPC_ARGUMENTS = {
  accept_waitlist_invite: ['p_token_hash', 'p_name', 'p_password_hash', 'p_timezone', 'p_avatar_seed'],
  increment_blog_views: ['p_slug'],
  increment_question_served: ['question'],
  toggle_blog_like: ['p_blog_id', 'p_user_id'],
};

class PostgresQuery {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    if (!IDENTIFIER.test(table)) throw new Error(`Unsafe SQL table: ${table}`);
    this.operation = 'select';
    this.fields = '*';
    this.filters = [];
    this.orders = [];
    this.limitValue = null;
    this.rangeValue = null;
    this.cardinality = null;
    this.returning = false;
    this.countMode = null;
    this.head = false;
    this.values = null;
    this.upsertOptions = null;
    this.promise = null;
  }

  select(fields = '*', options = {}) {
    this.fields = fields;
    this.returning = this.operation !== 'select' || this.returning;
    if (options?.count) this.countMode = options.count;
    if (options?.head) this.head = true;
    return this;
  }

  eq(column, value) { return this.addFilter(column, 'eq', value); }
  neq(column, value) { return this.addFilter(column, 'neq', value); }
  gt(column, value) { return this.addFilter(column, 'gt', value); }
  gte(column, value) { return this.addFilter(column, 'gte', value); }
  lt(column, value) { return this.addFilter(column, 'lt', value); }
  lte(column, value) { return this.addFilter(column, 'lte', value); }
  like(column, value) { return this.addFilter(column, 'like', value); }
  ilike(column, value) { return this.addFilter(column, 'ilike', value); }
  is(column, value) { return this.addFilter(column, 'is', value); }

  in(column, values) {
    if (!Array.isArray(values) || values.length === 0) {
      this.filters.push({ sql: 'FALSE', values: [] });
      return this;
    }
    this.filters.push({ sql: `${parseColumn(column)} = ANY(?)`, values: [values] });
    return this;
  }

  contains(column, value) {
    this.filters.push({ sql: `${parseColumn(column)} @> ?`, values: [value] });
    return this;
  }

  not(column, operator, value) {
    if (operator === 'is' && (value === null || value === 'null')) {
      this.filters.push({ sql: `${parseColumn(column)} IS NOT NULL`, values: [] });
      return this;
    }
    const operatorSql = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', ilike: 'ILIKE' }[operator];
    if (!operatorSql) throw new Error(`Unsupported NOT operator: ${operator}`);
    this.filters.push({ sql: `${parseColumn(column)} NOT (${operatorSql} ?)`, values: [value] });
    return this;
  }

  match(values) {
    for (const [column, value] of Object.entries(values ?? {})) this.eq(column, value);
    return this;
  }

  or(expression) {
    const clauses = String(expression).split(',').map((item) => item.trim()).filter(Boolean);
    const parts = [];
    const values = [];
    for (const clause of clauses) {
      const [column, operator, ...rest] = clause.split('.');
      const value = rest.join('.');
      const operatorSql = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', ilike: 'ILIKE' }[operator];
      if (!operatorSql) throw new Error(`Unsupported OR operator: ${operator}`);
      parts.push(`${parseColumn(column)} ${operatorSql} ?`);
      values.push(sqlLike(value));
    }
    if (parts.length) this.filters.push({ sql: `(${parts.join(' OR ')})`, values });
    return this;
  }

  order(column, options = {}) {
    this.orders.push(`${parseColumn(column)} ${options.ascending === false ? 'DESC' : 'ASC'}`);
    return this;
  }

  limit(value) {
    this.limitValue = Math.max(0, Number(value));
    return this;
  }

  range(from, to) {
    this.rangeValue = { from: Math.max(0, Number(from)), to: Math.max(0, Number(to)) };
    return this;
  }

  single() {
    this.cardinality = 'single';
    return this;
  }

  maybeSingle() {
    this.cardinality = 'maybeSingle';
    return this;
  }

  insert(values) {
    this.operation = 'insert';
    this.values = values;
    return this;
  }

  update(values) {
    this.operation = 'update';
    this.values = values;
    return this;
  }

  upsert(values, options = {}) {
    this.operation = 'upsert';
    this.values = values;
    this.upsertOptions = options;
    return this;
  }

  delete() {
    this.operation = 'delete';
    return this;
  }

  addFilter(column, operator, value) {
    const sqlColumn = parseColumn(column);
    if (operator === 'is' && (value === null || value === 'null')) {
      this.filters.push({ sql: `${sqlColumn} IS NULL`, values: [] });
      return this;
    }
    const operatorSql = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', ilike: 'ILIKE' }[operator];
    if (!operatorSql) throw new Error(`Unsupported filter operator: ${operator}`);
    this.filters.push({ sql: `${sqlColumn} ${operatorSql} ?`, values: [operator === 'like' || operator === 'ilike' ? sqlLike(value) : value] });
    return this;
  }

  then(resolve, reject) {
    this.promise ??= this.execute();
    return this.promise.then(resolve, reject);
  }

  catch(reject) {
    this.promise ??= this.execute();
    return this.promise.catch(reject);
  }

  finally(callback) {
    this.promise ??= this.execute();
    return this.promise.finally(callback);
  }

  buildWhere(parameters) {
    const clauses = [];
    for (const filter of this.filters) {
      const sql = filter.sql.replace(/\?/g, () => {
        const value = filter.values.shift();
        parameters.push(value);
        return `$${parameters.length}`;
      });
      clauses.push(sql);
    }
    return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  }

  buildReturning() {
    if (!this.returning) return '';
    const parsed = parseFields(this.fields);
    return ` RETURNING ${parsed.columns[0] === '*' ? '*' : parsed.columns.map(parseColumn).join(', ')}`;
  }

  async execute() {
    const parameters = [];
    try {
      if (this.operation === 'select') return await this.executeSelect(parameters);
      if (this.operation === 'insert' || this.operation === 'upsert') return await this.executeInsert(parameters);
      if (this.operation === 'update') return await this.executeUpdate(parameters);
      return await this.executeDelete(parameters);
    } catch (error) {
      return { data: null, error: toError(error), count: null };
    }
  }

  async executeSelect(parameters) {
    const parsed = parseFields(this.fields);
    const selected = parsed.columns[0] === '*' ? ['*'] : parsed.columns.map(parseColumn);
    const hiddenForeignKeys = [];
    for (const relation of parsed.relations) {
      const foreignKey = relationForeignKey(this.table, relation.alias);
      if (!selected.includes('*') && !selected.includes(parseColumn(foreignKey))) {
        selected.push(parseColumn(foreignKey));
        hiddenForeignKeys.push(foreignKey);
      }
    }
    const selectSql = selected.join(', ');
    const where = this.buildWhere(parameters);
    if (this.head && this.countMode) {
      const countResult = await this.client.pool.query(`SELECT count(*)::int AS count FROM ${tableIdentifier(this.table)}${where}`, parameters);
      return { data: null, error: null, count: countResult.rows[0]?.count ?? 0 };
    }
    const countColumn = this.countMode ? ', count(*) OVER()::int AS __total_count' : '';
    let sql = `SELECT ${selectSql}${countColumn} FROM ${tableIdentifier(this.table)}${where}`;
    if (this.orders.length) sql += ` ORDER BY ${this.orders.join(', ')}`;
    if (this.rangeValue) {
      sql += ` LIMIT ${this.rangeValue.to - this.rangeValue.from + 1} OFFSET ${this.rangeValue.from}`;
    } else if (this.limitValue !== null) {
      sql += ` LIMIT ${this.limitValue}`;
    }
    const result = await this.client.pool.query(sql, parameters);
    const count = this.countMode ? Number(result.rows[0]?.__total_count ?? 0) : null;
    const rows = result.rows.map((row) => {
      const copy = { ...row };
      delete copy.__total_count;
      for (const key of hiddenForeignKeys) delete copy[key];
      return copy;
    });
    await this.attachRelations(rows, parsed.relations);
    return this.applyCardinality(rows, count);
  }

  async attachRelations(rows, relations) {
    for (const relation of relations) {
      const foreignKey = relationForeignKey(this.table, relation.alias);
      const ids = [...new Set(rows.map((row) => row[foreignKey]).filter(Boolean))];
      if (!ids.length) {
        rows.forEach((row) => { row[relation.alias] = null; });
        continue;
      }
      const parsed = parseFields(relation.fields);
      const selected = parsed.columns[0] === '*' ? ['*'] : parsed.columns.map(parseColumn);
      const sql = `SELECT ${selected.join(', ')} FROM ${tableIdentifier(relation.table)} WHERE ${quoteIdentifier('id')} = ANY($1)`;
      const result = await this.client.pool.query(sql, [ids]);
      const byId = new Map(result.rows.map((row) => [String(row.id), row]));
      rows.forEach((row) => { row[relation.alias] = byId.get(String(row[foreignKey])) ?? null; });
    }
  }

  applyCardinality(rows, count = null) {
    if (this.cardinality === 'single') {
      if (rows.length !== 1) return { data: null, error: { message: `Expected one row, got ${rows.length}`, code: 'PGRST116' }, count };
      return { data: rows[0], error: null, count };
    }
    if (this.cardinality === 'maybeSingle') {
      if (rows.length > 1) return { data: null, error: { message: `Expected zero or one row, got ${rows.length}`, code: 'PGRST116' }, count };
      return { data: rows[0] ?? null, error: null, count };
    }
    return { data: rows, error: null, count };
  }

  async executeInsert(parameters) {
    const rows = Array.isArray(this.values) ? this.values : [this.values];
    if (!rows.length) return { data: [], error: null, count: 0 };
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    columns.forEach((column) => quoteIdentifier(column));
    const valuesSql = rows.map((row) => `(${columns.map((column) => {
      parameters.push(row[column] ?? null);
      return `$${parameters.length}`;
    }).join(', ')})`).join(', ');
    let sql = `INSERT INTO ${tableIdentifier(this.table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES ${valuesSql}`;
    if (this.operation === 'upsert') {
      const conflictColumns = (this.upsertOptions?.onConflict ?? '').split(',').map((value) => value.trim()).filter(Boolean);
      conflictColumns.forEach((column) => quoteIdentifier(column));
      if (this.upsertOptions?.ignoreDuplicates) {
        sql += conflictColumns.length ? ` ON CONFLICT (${conflictColumns.map(quoteIdentifier).join(', ')}) DO NOTHING` : ' ON CONFLICT DO NOTHING';
      } else {
        const updates = columns.filter((column) => !conflictColumns.includes(column));
        sql += ` ON CONFLICT${conflictColumns.length ? ` (${conflictColumns.map(quoteIdentifier).join(', ')})` : ''} DO UPDATE SET ${updates.length ? updates.map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`).join(', ') : `${quoteIdentifier(conflictColumns[0] ?? columns[0])} = EXCLUDED.${quoteIdentifier(conflictColumns[0] ?? columns[0])}`}`;
      }
    }
    sql += this.buildReturning();
    const result = await this.client.pool.query(sql, parameters);
    if (!this.returning) return { data: null, error: null, count: result.rowCount };
    return this.applyCardinality(result.rows, result.rowCount);
  }

  async executeUpdate(parameters) {
    const entries = Object.entries(this.values ?? {});
    if (!entries.length) return { data: [], error: null, count: 0 };
    const assignments = entries.map(([column, value]) => {
      parameters.push(value);
      return `${parseColumn(column)} = $${parameters.length}`;
    });
    const where = this.buildWhere(parameters);
    const result = await this.client.pool.query(`UPDATE ${tableIdentifier(this.table)} SET ${assignments.join(', ')}${where}${this.buildReturning()}`, parameters);
    if (!this.returning) return { data: null, error: null, count: result.rowCount };
    return this.applyCardinality(result.rows, result.rowCount);
  }

  async executeDelete(parameters) {
    const where = this.buildWhere(parameters);
    const result = await this.client.pool.query(`DELETE FROM ${tableIdentifier(this.table)}${where}${this.returning ? this.buildReturning() : ''}`, parameters);
    if (!this.returning) return { data: null, error: null, count: result.rowCount };
    return this.applyCardinality(result.rows, result.rowCount);
  }
}

export class PostgresClient {
  constructor() {
    this.pool = new Pool({
      connectionString: env.database.url || undefined,
      host: env.database.host || undefined,
      port: env.database.port,
      database: env.database.name,
      user: env.database.user,
      password: env.database.password,
      max: env.database.poolMax,
      idleTimeoutMillis: env.database.idleTimeoutMs,
      connectionTimeoutMillis: env.database.connectTimeoutMs,
      ssl: env.database.ssl ? { rejectUnauthorized: false } : undefined,
    });
    this.pool.on('error', (error) => console.error('[postgres] idle client error:', error.message));
  }

  from(table) {
    return new PostgresQuery(this, table);
  }

  async rpc(name, args = {}) {
    try {
      if (!IDENTIFIER.test(name)) throw new Error(`Unsafe SQL function: ${name}`);
      const argumentNames = RPC_ARGUMENTS[name] ?? Object.keys(args);
      const parameters = argumentNames.map((argument) => args[argument]);
      const placeholders = parameters.map((_, index) => `$${index + 1}`).join(', ');
      const result = await this.pool.query(`SELECT * FROM ${tableIdentifier(name)}(${placeholders})`, parameters);
      return { data: result.rows, error: null, count: result.rowCount };
    } catch (error) {
      return { data: null, error: toError(error), count: null };
    }
  }
}
