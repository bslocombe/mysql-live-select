var _            = require('lodash')
var md5          = require('md5')
var pg           = require('pg')
var randomString = require('random-strings')

var collectionDiff = require('./collectionDiff')
var matchRows      = require('./matchRowsToParsedQuery')

module.exports = exports = {

	/**
	 * Obtain a node-postgres client from the connection pool
	 * @param  String  connectionString "postgres://user:pass@host/database"
	 * @return Promise { client, done() } Call done() to return client to pool!
	 */
	getClient(connectionString) {
		return new Promise((resolve, reject) => {
			pg.connect(connectionString, (error, client, done) => {
				if(error) reject(error)
				else resolve({ client, done })
			})
		})
	},

	/**
	 * Perform a query
	 * @param  Object client node-postgres client
	 * @param  String query  SQL statement
	 * @param  Array  params Optional, values to substitute into query
	 *                       (params[0] => '$1'...)
	 * @return Promise Array Result set
	 */
	performQuery(client, query, params=[]) {
		return new Promise((resolve, reject) => {
			client.query(query, params, (error, result) => {
				if(error) reject(error)
				else resolve(result)
			})
		})
	},

	delay(duration=0) {
		return new Promise((resolve, reject) => setTimeout(resolve, duration))
	},

	/**
	 * Query information_schema to determine tables used and if updatable
	 * @param  Object client node-postgres client
	 * @param  String query  SQL statement, params not used
	 * @return Promise Array Table names
	 */
	async getQueryDetails(client, query) {
		var nullifiedQuery = query.replace(/\$\d+/g, 'NULL')
		var viewName = `tmp_view_${randomString.alphaLower(10)}`

		await exports.performQuery(client,
			`CREATE OR REPLACE TEMP VIEW ${viewName} AS (${nullifiedQuery})`)

		var tablesResult = await exports.performQuery(client,
			`SELECT DISTINCT vc.table_name
				FROM information_schema.view_column_usage vc
				WHERE view_name = $1`, [ viewName ])

		var isUpdatableResult = await exports.performQuery(client,
			`SELECT is_updatable
				FROM information_schema.views
				WHERE table_name = $1`, [ viewName ])

		var isUpdatable = isUpdatableResult.rows[0].is_updatable === 'YES'

		await exports.performQuery(client, `DROP VIEW ${viewName}`)

		var tablesUsed = tablesResult.rows.map(row => row.table_name)

		var primaryKeys = null
		// Reading the primary keys only necessary if simple query on one table
		if(isUpdatable === true) {
			let primaryKeysResult = await exports.performQuery(client,
				`SELECT a.attname
					FROM pg_index i
					JOIN pg_attribute a
						ON a.attrelid = i.indrelid
							AND a.attnum = ANY(i.indkey)
					WHERE i.indrelid = $1::regclass
						AND i.indisprimary`, [ tablesUsed[0] ])

			primaryKeys = primaryKeysResult.rows.map(row => row.attname)
		}

		return {
			isUpdatable,
			tablesUsed,
			primaryKeys
		}
	},

	/**
	 * Create a trigger to send NOTIFY on any change with payload of table name
	 * @param  Object client  node-postgres client
	 * @param  String table   Name of table to install trigger
	 * @param  String channel NOTIFY channel
	 * @return Promise true   Successful
	 */
	async createTableTrigger(client, table, channel) {
		var triggerName = `${channel}_${table}`

		var payloadTpl = `
			SELECT
				'${table}'  AS table,
				TG_OP       AS op,
				json_agg($ROW$) AS data
			INTO row_data;
		`
		var payloadNew = payloadTpl.replace(/\$ROW\$/g, 'NEW')
		var payloadOld = payloadTpl.replace(/\$ROW\$/g, 'OLD')
		var payloadChanged = `
			SELECT
				'${table}'  AS table,
				TG_OP       AS op,
				json_agg(NEW) AS new_data,
				json_agg(OLD) AS old_data
			INTO row_data;
		`

		await exports.performQuery(client,
			`CREATE OR REPLACE FUNCTION ${triggerName}() RETURNS trigger AS $$
				DECLARE
          row_data RECORD;
        BEGIN
          IF (TG_OP = 'INSERT') THEN
            ${payloadNew}
          ELSIF (TG_OP  = 'DELETE') THEN
            ${payloadOld}
          ELSIF (TG_OP = 'UPDATE') THEN
            ${payloadChanged}
          END IF;
          PERFORM pg_notify('${channel}', row_to_json(row_data)::TEXT);
          RETURN NULL;
				END;
			$$ LANGUAGE plpgsql`)

		await exports.performQuery(client,
			`DROP TRIGGER IF EXISTS "${triggerName}"
				ON "${table}"`)

		await exports.performQuery(client,
			`CREATE TRIGGER "${triggerName}"
				AFTER INSERT OR UPDATE OR DELETE ON "${table}"
				FOR EACH ROW EXECUTE PROCEDURE ${triggerName}()`)

		return true
	},

	/**
	 * Drop matching function and trigger for a table
	 * @param  Object client  node-postgres client
	 * @param  String table   Name of table to remove trigger
	 * @param  String channel NOTIFY channel
	 * @return Promise true   Successful
	 */
	async dropTableTrigger(client, table, channel) {
		var triggerName = `${channel}_${table}`

		await exports.performQuery(client,
			`DROP TRIGGER IF EXISTS ${triggerName} ON ${table}`)

		await exports.performQuery(client,
			`DROP FUNCTION IF EXISTS ${triggerName}()`)

		return true
	},

	/**
	 * Using supplied NOTIFY payloads, check which rows match query
	 * @param  Object  client        node-postgres client (Used only in fallback)
	 * @param  Array   currentData   Last known result set for this query/params
	 * @param  Array   notifications Payloads from NOTIFY
	 * @param  String  query         SQL SELECT statement
	 * @param  String  parsed        Parsed SQL SELECT statement
	 * @param  Array   params        Optionally, pass an array of parameters
	 * @return Promise Object        Enumeration of differences
	 */
	async getDiffFromSupplied(
		client, currentData, notifications, query, parsed, params) {

		await exports.delay()

		var allRows   = flattenNotifications(notifications)
		var matched   = matchRows(allRows, parsed, params)
		if(matched.length === 0) return null

		var oldHashes = currentData.map(row => row._hash)
		var newData   = currentData.slice()
		var hasDelete = false

		for(let matchRow of matched) {

			let cleanRow = _.clone(matchRow)
			// All extra fields must be removed for hashing
			delete cleanRow._op
			delete cleanRow._key
			delete cleanRow._index

			// Remove any columns not selected by query
			if(!(parsed.fields.length === 1
				&& parsed.fields[0].constructor.name === 'Star')) {

				let columnsSelected = {}
				parsed.fields.forEach(item => {
					// If the column is renamed in the output, rename the column
					columnsSelected[item.field.value] =
						item.name ? item.name.value : item.field.value
				})

				// Build new row with correct columns included and sorted
				let reformedRow = {}
				for(let column of Object.keys(columnsSelected)) {
					reformedRow[columnsSelected[column]] = cleanRow[column]
				}
				cleanRow = reformedRow
			}

			cleanRow._hash = md5.digest_s(JSON.stringify(cleanRow))

			let curIndex = oldHashes.indexOf(cleanRow._hash)

			if(curIndex !== -1
				&& (matchRow._op === 'DELETE'
					|| (matchRow._op === 'UPDATE'
						&& matchRow._key === 'old_data'))) {

				newData[curIndex] = undefined
				hasDelete = true
			}

			if(matchRow._op === 'INSERT'
				|| (matchRow._op === 'UPDATE'
					&& matchRow._key === 'new_data')) {
				cleanRow._added = 1
				newData.push(cleanRow)
			}
		}

		if(hasDelete === true
			&& parsed.limit
			&& parsed.limit.value.value === currentData.length) {

			// Force full refresh
			return await exports.getResultSetDiff(client, currentData, query, params)
		}

		// Clean out deleted rows
		newData = newData.filter(row => row !== undefined)

		// Apply ORDER BY, LIMIT
		// Queries with unsupported clauses (e.g. OFFSET) filtered upstream
		if(parsed.order) {
			let sortProps = parsed.order.orderings.map(ordering =>
				ordering.value.value)
			let sortOrders = parsed.order.orderings.map(ordering =>
				ordering.direction.toUpperCase() === 'ASC')
			newData = _.sortByOrder(newData, sortProps, sortOrders)
		}

		if(parsed.limit) {
			newData = newData.slice(0, parsed.limit.value.value)
		}

		// Fix indexes
		for(let index of _.range(newData.length)) {
			newData[index]._index = index + 1
		}

		var diff = collectionDiff(oldHashes, newData)

		if(diff === null) return null

		return { diff, data: newData }
	},

	/**
	 * Perform SELECT query, obtaining difference in result set
	 * @param  Object  client      node-postgres client
	 * @param  Array   currentData Last known result set for this query/params
	 * @param  String  query       SQL SELECT statement
	 * @param  Array   params      Optionally, pass an array of parameters
	 * @return Promise Object      Enumeration of differences
	 */
	async getResultSetDiff(client, currentData, query, params) {
		var oldHashes = currentData.map(row => row._hash)

		var result = await exports.performQuery(client, `
			WITH
				res AS (${query}),
				data AS (
					SELECT
						res.*,
						MD5(CAST(ROW_TO_JSON(res.*) AS TEXT)) AS _hash,
						ROW_NUMBER() OVER () AS _index
					FROM res),
				data2 AS (
					SELECT
						1 AS _added,
						data.*
					FROM data
					WHERE _hash NOT IN ('${oldHashes.join("','")}'))
			SELECT
				data2.*,
				data._hash AS _hash
			FROM data
			LEFT JOIN data2
				ON (data._index = data2._index)`, params)

		var diff = collectionDiff(oldHashes, result.rows)

		if(diff === null) return null

		var newData = exports.applyDiff(currentData, diff)

		return { diff, data: newData }
	},

	/**
	 * Apply a diff to a result set
	 * @param  Array  data Last known full result set
	 * @param  Object diff Output from getResultSetDiff()
	 * @return Array       New result set
	 */
	applyDiff(data, diff) {
		var newResults = data.slice()

		diff.removed !== null && diff.removed
			.forEach(removed => newResults[removed._index - 1] = undefined)

		// Deallocate first to ensure no overwrites
		diff.moved !== null && diff.moved.forEach(moved => {
			newResults[moved.old_index - 1] = undefined
		});

		diff.copied !== null && diff.copied.forEach(copied => {
			var copyRow = _.clone(data[copied.orig_index - 1])
			copyRow._index = copied.new_index
			newResults[copied.new_index - 1] = copyRow
		});

		diff.moved !== null && diff.moved.forEach(moved => {
			var movingRow = data[moved.old_index - 1]
			movingRow._index = moved.new_index
			newResults[moved.new_index - 1] = movingRow
		});

		diff.added !== null && diff.added
			.forEach(added => newResults[added._index - 1] = added)

		return newResults.filter(row => row !== undefined)
	},

}

// Helper for getDiffFromSupplied
function flattenNotifications(notifications) {
	var out = []
	var pushItem = (payload, key, index) => {
		let data = _.clone(payload[key][0])
		data._op = payload.op
		data._key = key
		data._index = index
		out.push(data)
	}

	notifications.forEach((payload, index) => {
		if(payload.op === 'UPDATE') {
			pushItem(payload, 'new_data', index)
			pushItem(payload, 'old_data', index)
		}
		else {
			pushItem(payload, 'data', index)
		}
	})

	return out
}
