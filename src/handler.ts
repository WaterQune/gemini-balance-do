import { DurableObject } from 'cloudflare:workers';
import { isAdminAuthenticated } from './auth';

class HttpError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = this.constructor.name;
		this.status = status;
	}
}

const fixCors = ({ headers, status, statusText }: { headers?: HeadersInit; status?: number; statusText?: string }) => {
	const newHeaders = new Headers(headers);
	newHeaders.set('Access-Control-Allow-Origin', '*');
	newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
	newHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-key');
	return { headers: newHeaders, status, statusText };
};

const BASE_URL = 'https://generativelanguage.googleapis.com';
const API_VERSION = 'v1beta';
const API_CLIENT = 'genai-js/0.21.0';

const makeHeaders = (apiKey: string, more?: Record<string, string>) => ({
	'x-goog-api-client': API_CLIENT,
	...(apiKey && { 'x-goog-api-key': apiKey }),
	...more,
});

/** A Durable Object's behavior is defined in an exported Javascript class */
export class LoadBalancer extends DurableObject {
	env: Env;
	/**
	 * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
	 * 	`DurableObjectStub::get` for a given identifier (no-op constructors can be omitted)
	 *
	 * @param ctx - The interface for interacting with the Durable Object state
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 */
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.env = env;
		// Initialize the database schema upon first creation.
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS api_keys (
				api_key TEXT PRIMARY KEY
			);
			CREATE TABLE IF NOT EXISTS api_key_statuses (
				api_key TEXT PRIMARY KEY,
				status TEXT CHECK(status IN ('normal', 'abnormal')) NOT NULL DEFAULT 'normal',
				last_checked_at INTEGER,
				failed_count INTEGER NOT NULL DEFAULT 0,
				key_group TEXT CHECK(key_group IN ('normal', 'abnormal')) NOT NULL DEFAULT 'normal',
				FOREIGN KEY(api_key) REFERENCES api_keys(api_key) ON DELETE CASCADE
			);
		`);
		this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000); // Set an alarm to run in 5 minutes
	}

	async alarm() {
		// 1. Retry abnormal keys. Never delete a stored key because a check failed.
		const abnormalKeys = await this.ctx.storage.sql
			.exec("SELECT api_key, failed_count FROM api_key_statuses WHERE key_group = 'abnormal'")
			.raw<any>();

		for (const row of Array.from(abnormalKeys)) {
			const apiKey = row[0] as string;
			const failedCount = row[1] as number;
			let response: Response;

			try {
				response = await fetch(`${BASE_URL}/${API_VERSION}/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }),
				});
			} catch (error) {
				console.error(`Error checking abnormal key ${apiKey}:`, error);
				continue;
			}

			if (response.ok) {
				// A successful check restores the key to the normal group.
				await this.ctx.storage.sql.exec(
					"UPDATE api_key_statuses SET status = 'normal', key_group = 'normal', failed_count = 0, last_checked_at = ? WHERE api_key = ?",
					Date.now(),
					apiKey
				);
			} else {
				// Keep the key in the abnormal group and retry later, regardless of HTTP status.
				await this.ctx.storage.sql.exec(
					"UPDATE api_key_statuses SET status = 'abnormal', key_group = 'abnormal', failed_count = ?, last_checked_at = ? WHERE api_key = ?",
					failedCount + 1,
					Date.now(),
					apiKey
