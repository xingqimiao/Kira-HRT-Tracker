/**
 * End-to-end check for the encrypted record store.
 *
 * The property that matters cannot be asserted from the API alone: a service that
 * "encrypts" and returns the plaintext on read passes any round-trip test while storing
 * everything in the clear. So this reads the column directly and asserts the plaintext
 * is not in it, then reads through the service and asserts it comes back.
 *
 *   cd server
 *   node --experimental-transform-types scripts/check-records.mjs
 *
 * Uses the same throwaway Postgres helper as the server tests.
 */
import { rmSync } from 'node:fs'

const DIR = './.pgdata-records'
const PORT = 55461
const DATABASE = 'hrt_records'

rmSync(DIR, { recursive: true, force: true })

const EmbeddedPostgres = (await import('embedded-postgres')).default
const instance = new EmbeddedPostgres({
    databaseDir: DIR,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
})
await instance.initialise()
await instance.start()
await instance.createDatabase(DATABASE)

process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${PORT}/${DATABASE}`
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64')
process.env.NODE_ENV = 'production'
process.env.PUBLIC_ORIGIN = 'https://example.test'
process.env.API_ORIGIN = 'https://api.example.test'
process.env.JWT_SECRET = 'x'.repeat(40)
process.env.SERVER_DEK_KEY = 'z'.repeat(40)

const { RecordService } = await import('../src/records.ts')
const { getPool, migrate } = await import('../src/db.ts')
await migrate()

const results = []
async function check(name, fn) {
    try {
        await fn()
        results.push(['pass', name])
    } catch (error) {
        results.push(['fail', name, error.message])
    }
}

const { rows: userRows } = await getPool().query(
    `INSERT INTO users (username) VALUES ($1) RETURNING id`,
    ['records_probe'],
)
const ctx = { userId: userRows[0].id }

try {
    await check('a record round-trips through the service', async () => {
        const payload = { med_name: '雌二醇', dosage: '2mg', note: '舌下含服' }
        const written = await RecordService.put(ctx, { takenAt: Date.now(), data: payload })
        if (!written.ok) throw new Error(`write failed: ${written.error}`)

        const { records } = await RecordService.list(ctx, {})
        const found = records.find((r) => r.id === written.id)
        if (!found) throw new Error('the record was not returned')
        if (JSON.stringify(found.data) !== JSON.stringify(payload)) {
            throw new Error(`payload changed: ${JSON.stringify(found.data)}`)
        }
    })

    await check('the plaintext is genuinely absent from the column', async () => {
        const secret = 'CONFIDENTIAL_MED_NAME_9471'
        const written = await RecordService.put(ctx, { takenAt: Date.now(), data: { med_name: secret } })
        if (!written.ok) throw new Error(`write failed: ${written.error}`)

        const { rows } = await getPool().query(
            `SELECT payload_encrypted FROM records WHERE id = $1`,
            [written.id],
        )
        const stored = rows[0].payload_encrypted
        if (stored.includes(secret)) throw new Error('the plaintext is in the stored column')
        const parts = stored.split(':')
        if (parts.length !== 3) throw new Error(`stored form is not iv:tag:ciphertext: ${stored.slice(0, 40)}`)
    })

    await check('no plaintext column survives but the ones that address a row', async () => {
        const { rows } = await getPool().query(
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'records'
              ORDER BY column_name`,
        )
        const names = rows.map((r) => r.column_name)
        // `client_id` was in this list until the id became the client's own identity;
        // a second key could only disagree with the first, and did.
        const expected = ['category', 'created_at', 'id', 'payload_encrypted', 'taken_at', 'updated_at', 'user_id']
        if (names.join(',') !== expected.join(',')) throw new Error(`columns are: ${names.join(',')}`)
    })

    await check('an identical payload seals differently each time', async () => {
        const payload = { med_name: 'same', dosage: 'same' }
        const a = await RecordService.put(ctx, { takenAt: Date.now(), data: payload })
        const b = await RecordService.put(ctx, { takenAt: Date.now(), data: payload })
        // `text[]`, not `uuid[]`: the ids are the client's structured strings
        // (`dose:transfem:…`), which is why the column is text in the first place.
        const { rows } = await getPool().query(
            `SELECT id, payload_encrypted FROM records WHERE id = ANY($1::text[])`,
            [[a.id, b.id]],
        )
        if (rows.length !== 2) throw new Error('expected two rows')
        if (rows[0].payload_encrypted === rows[1].payload_encrypted) {
            throw new Error('two identical records produced the same ciphertext')
        }
    })

    await check('records come back newest first', async () => {
        const base = Date.now()
        await RecordService.put(ctx, { takenAt: base - 60_000, data: { tag: 'older' } })
        await RecordService.put(ctx, { takenAt: base, data: { tag: 'newer' } })
        const { records } = await RecordService.list(ctx, { limit: 2 })
        const tags = records.map((r) => r.data.tag)
        if (tags[0] !== 'newer') throw new Error(`order was: ${tags.join(',')}`)
    })

    await check('category filtering works and rejects an unknown category', async () => {
        await RecordService.put(ctx, { takenAt: Date.now(), category: 'lab', data: { tag: 'a-lab' } })
        const labs = await RecordService.list(ctx, { category: 'lab' })
        if (!labs.records.every((r) => r.category === 'lab')) throw new Error('a non-lab record leaked in')

        const bogus = await RecordService.list(ctx, { category: 'not-a-category' })
        if (bogus.records.length !== 0) throw new Error('an unknown category returned rows')
    })

    await check('a re-sent write with the same id updates rather than duplicates', async () => {
        // The id is the idempotency key. This used to pass a separate `clientId`; the
        // column is gone, because a second key can only disagree with the first — and
        // did, producing a primary-key violation on every re-sync once both applied.
        const first = await RecordService.put(ctx, {
            takenAt: Date.now(), id: 'dose:transfem:offline-1', data: { note: 'first' },
        })
        const second = await RecordService.put(ctx, {
            takenAt: Date.now(), id: 'dose:transfem:offline-1', data: { note: 'second' },
        })
        if (!first.ok || !second.ok) throw new Error('a write failed')
        if (first.id !== second.id) throw new Error('the retry created a second row')

        const { records } = await RecordService.list(ctx, {})
        const found = records.find((r) => r.id === first.id)
        if (found.data.note !== 'second') throw new Error('the retry did not overwrite')
    })

    await check('an unparseable timestamp is refused, not defaulted to now', async () => {
        const bad = await RecordService.put(ctx, { takenAt: 'not a date', data: { x: 1 } })
        if (bad.ok) throw new Error('a bogus timestamp was accepted')
    })

    await check('a missing payload is refused', async () => {
        const bad = await RecordService.put(ctx, { takenAt: Date.now() })
        if (bad.ok) throw new Error('a record with no data was accepted')
    })

    await check('an unknown category is refused on write', async () => {
        const bad = await RecordService.put(ctx, { takenAt: Date.now(), category: 'nope', data: { x: 1 } })
        if (bad.ok) throw new Error('an unknown category was accepted')
    })

    await check('a corrupt row is counted and does not hide the rest', async () => {
        // The id is explicit because the column has no default any more — it is the
        // client's own key, so the server never invents one for a row it did not write.
        await getPool().query(
            `INSERT INTO records (user_id, taken_at, category, payload_encrypted, id)
             VALUES ($1, now(), 'dose', 'AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:BBBB', 'dose:transfem:corrupt')`,
            [ctx.userId],
        )
        const { records, unreadable } = await RecordService.list(ctx, {})
        if (unreadable !== 1) throw new Error(`expected 1 unreadable row, got ${unreadable}`)
        if (records.length < 2) throw new Error('the good rows were hidden by the bad one')
    })

    await check('deleting is scoped to the owner', async () => {
        const written = await RecordService.put(ctx, { takenAt: Date.now(), data: { x: 1 } })
        const { rows: other } = await getPool().query(
            `INSERT INTO users (username) VALUES ('records_other') RETURNING id`,
        )
        const stolen = await RecordService.remove({ userId: other[0].id }, written.id)
        if (stolen) throw new Error("another account's record was deleted")

        const mine = await RecordService.remove(ctx, written.id)
        if (!mine) throw new Error('the owner could not delete their own record')
    })
} finally {
    await getPool().end().catch(() => {})
    await instance.stop().catch(() => {})
    rmSync(DIR, { recursive: true, force: true })
}

for (const [status, name, detail] of results) {
    console.log(`${status === 'pass' ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const failed = results.filter(([s]) => s === 'fail').length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
