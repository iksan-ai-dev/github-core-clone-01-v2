// identity.ts — the fixed viewer and clock this forge answers as.
//
// The kit's wire.ts seeds one token and one account, so the server has no notion of a
// second user: every request is that account, every object belongs to it, and every
// timestamp it writes is the same frozen instant. Keeping those values in one module
// means the store, the REST layer and the git wire protocol cannot drift apart on what
// "the viewer" or "now" means.

/** The login the scenario's token belongs to. */
export const VIEWER_LOGIN = 'adaiversen';

/** The numeric id the REST and GraphQL payloads carry for that login. */
export const VIEWER_ID = 1000;

/** The display name, as GitHub returns it on the user object. */
export const VIEWER_NAME = 'ada iversen';

/** The address every commit this forge writes is authored and committed by. */
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** The all-zero object id a create or delete names in its ref update. */
export const ZERO_OID = '0'.repeat(40);

/** The one instant the suite's fixtures are written at. */
export const FIXED_TIME = '2025-01-01T00:00:00Z';

/** The epoch that instant is, for the commit objects the store builds. */
export const COMMIT_EPOCH = 1700000000;
