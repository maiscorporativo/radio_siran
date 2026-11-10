import knexFactory from 'knex';
import fs from 'node:fs';
import path from 'node:path';

const client = (process.env.DB_CLIENT || 'sqlite').toLowerCase();

function buildConfig() {
  if (client === 'mysql') {
    return {
      client: 'mysql2',
      connection: {
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        charset: 'utf8mb4',
      },
      pool: { min: 0, max: 10 },
    };
  }
  const dir = path.resolve('data');
  fs.mkdirSync(dir, { recursive: true });
  return {
    client: 'better-sqlite3',
    connection: { filename: path.join(dir, 'radio.db') },
    useNullAsDefault: true,
  };
}

export const db = knexFactory(buildConfig());

async function ensureTable(name, build) {
  if (!(await db.schema.hasTable(name))) {
    await db.schema.createTable(name, build);
  }
}

export async function migrate() {
  if (client !== 'mysql') {
    await db.raw('PRAGMA journal_mode = WAL');
    await db.raw('PRAGMA foreign_keys = ON');
  }

  await ensureTable('companies', (t) => {
    t.increments('id');
    t.string('name', 160).notNullable();
    t.bigInteger('created_at');
  });

  await ensureTable('playlists', (t) => {
    t.increments('id');
    t.integer('company_id').unsigned().notNullable().references('companies.id').onDelete('CASCADE');
    t.string('name', 160).notNullable();
    t.boolean('shuffle').defaultTo(true);
    t.bigInteger('created_at');
  });

  await ensureTable('units', (t) => {
    t.increments('id');
    t.integer('company_id').unsigned().notNullable().references('companies.id').onDelete('CASCADE');
    t.string('name', 160).notNullable();
    t.string('token', 64).notNullable().unique();
    t.integer('playlist_id').unsigned().nullable().references('playlists.id').onDelete('SET NULL');
    t.integer('volume').defaultTo(100);
    t.bigInteger('last_seen');
    t.text('status_json');
    t.bigInteger('created_at');
  });

  await ensureTable('media', (t) => {
    t.increments('id');
    t.integer('company_id').unsigned().notNullable().references('companies.id').onDelete('CASCADE');
    t.string('kind', 10).notNullable(); // music | spot
    t.string('title', 255).notNullable();
    t.string('artist', 255);
    t.string('filename', 255).notNullable();
    t.string('mime', 80);
    t.float('duration');
    t.bigInteger('size');
    t.bigInteger('created_at');
  });

  await ensureTable('playlist_items', (t) => {
    t.increments('id');
    t.integer('playlist_id').unsigned().notNullable().references('playlists.id').onDelete('CASCADE');
    t.integer('media_id').unsigned().notNullable().references('media.id').onDelete('CASCADE');
    t.integer('position').defaultTo(0);
  });

  await ensureTable('campaigns', (t) => {
    t.increments('id');
    t.integer('company_id').unsigned().notNullable().references('companies.id').onDelete('CASCADE');
    t.integer('unit_id').unsigned().nullable().references('units.id').onDelete('CASCADE'); // null = todas as unidades
    t.integer('media_id').unsigned().notNullable().references('media.id').onDelete('CASCADE');
    t.string('name', 160).notNullable();
    t.string('mode', 10).notNullable(); // tracks | minutes | times
    t.integer('interval_value').defaultTo(3);
    t.string('fixed_times', 500); // "09:00,12:30"
    t.string('start_date', 10); // YYYY-MM-DD
    t.string('end_date', 10);
    t.string('days', 7).defaultTo('0123456'); // 0=domingo
    t.string('hour_start', 5).defaultTo('00:00');
    t.string('hour_end', 5).defaultTo('23:59');
    t.integer('priority').defaultTo(0);
    t.boolean('active').defaultTo(true);
    t.bigInteger('created_at');
  });

  await ensureTable('queue', (t) => {
    t.increments('id');
    t.integer('unit_id').unsigned().notNullable().references('units.id').onDelete('CASCADE');
    t.integer('media_id').unsigned().notNullable().references('media.id').onDelete('CASCADE');
    t.string('mode', 10).defaultTo('next'); // next | now
    t.string('status', 10).defaultTo('pending'); // pending | playing | done | canceled
    t.bigInteger('created_at');
    t.bigInteger('played_at');
  });

  await ensureTable('commands', (t) => {
    t.increments('id');
    t.integer('unit_id').unsigned().notNullable().references('units.id').onDelete('CASCADE');
    t.string('cmd', 20).notNullable(); // skip | pause | resume | volume | reload
    t.string('value', 50);
    t.string('status', 10).defaultTo('pending');
    t.bigInteger('created_at');
  });

  // Fonte de música por unidade: 'library' (acervo próprio) ou 'spotify'
  if (!(await db.schema.hasColumn('units', 'music_source'))) {
    await db.schema.alterTable('units', (t) => {
      t.string('music_source', 10).defaultTo('library');
      t.string('spotify_playlist', 255);
    });
  }

  // Rodízio: campanha que usa todos os spots da empresa (media_id passa a ser opcional)
  if (!(await db.schema.hasColumn('campaigns', 'all_spots'))) {
    await db.schema.alterTable('campaigns', (t) => {
      t.boolean('all_spots').defaultTo(false);
      t.integer('per_break').defaultTo(1); // spots por intervalo; 0 = todos
    });
    await db.schema.alterTable('campaigns', (t) => {
      t.integer('media_id').unsigned().nullable().alter();
    });
  }

  // Reforço de volume dos spots, em % do volume da música (100 = igual)
  if (!(await db.schema.hasColumn('units', 'spot_boost'))) {
    await db.schema.alterTable('units', (t) => { t.integer('spot_boost').defaultTo(100); });
  }

  await ensureTable('play_logs', (t) => {
    t.increments('id');
    t.integer('unit_id').unsigned().notNullable().references('units.id').onDelete('CASCADE');
    t.integer('media_id').unsigned().nullable();
    t.string('kind', 10);
    t.string('title', 255);
    t.string('source', 20); // playlist | campaign | queue
    t.integer('campaign_id').unsigned().nullable();
    t.bigInteger('played_at').notNullable();
    t.string('client_ref', 40).unique(); // evita duplicar logs reenviados após queda de internet
    t.index(['unit_id', 'played_at']);
  });
}
