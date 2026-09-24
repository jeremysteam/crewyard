import postgres from 'postgres';

// SQL is applied by the project owner. The app never creates or alters a table.
export function createPostgresStore(connectionString) {
  const sql = postgres(connectionString, { max: 3, prepare: false, ssl: 'require' });

  function state(rows) {
    if (!rows.length) throw new Error('Board database schema is missing; apply the reviewed SQL first');
    return rows[0].data;
  }

  return {
    read: async fn => fn(state(await sql`SELECT data FROM board_private.state WHERE singleton = true`)),
    write: fn => sql.begin(async transaction => {
      const data = state(await transaction`SELECT data FROM board_private.state WHERE singleton = true FOR UPDATE`);
      const result = await fn(data);
      await transaction`UPDATE board_private.state SET data = ${sql.json(data)} WHERE singleton = true`;
      return result;
    }),
  };
}
