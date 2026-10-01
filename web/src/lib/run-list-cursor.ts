import "server-only";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;

export function encodeRunCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id])).toString("base64url");
}

export function decodeRunCursor(cursor: string): { createdAt: string; id: string } {
  try {
    if (cursor.length > 256) throw new Error();
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (!Array.isArray(value) || value.length !== 2 ||
        typeof value[0] !== "string" || !TIMESTAMP.test(value[0]) ||
        !Number.isFinite(Date.parse(`${value[0]}Z`)) ||
        typeof value[1] !== "string" || !UUID.test(value[1])) throw new Error();
    if (new Date(`${value[0]}Z`).toISOString().slice(0, 19) !== value[0].slice(0, 19)) {
      throw new Error();
    }
    return { createdAt: value[0], id: value[1] };
  } catch {
    throw new Error("Invalid run cursor");
  }
}
