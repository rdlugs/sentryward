// One structured line per audited event, picked up by the log shipper.
export function audit(event: string, data: Record<string, unknown>): void {
  console.info(JSON.stringify({ event, at: new Date().toISOString(), ...data }));
}
