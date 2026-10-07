/**
 * The bindings this Worker is given.
 *
 * Kept in its own module with no imports, so it cannot take part in a type cycle
 * with the code that uses it.
 *
 * Unlike the presence room, this Worker **does** hold a service-role key, and
 * that is the whole reason it exists. The storage ledger's two writers
 * (`register_storage_object`, `remove_storage_object`) are revoked from
 * `authenticated` on purpose: a client that could write `byte_size` itself could
 * write itself an unlimited allowance in a single call. Somebody trustworthy has
 * to make those calls, and a desktop application is not trustworthy — its
 * binaries and its environment are on the user's own machine.
 *
 * Everything that keeps that key from being a liability is in `index.ts`: it is
 * never sent anywhere a caller can see, every value it is used with is derived
 * from a token the caller had to present, and the caller's identity is taken
 * from Supabase's answer rather than from anything the caller wrote.
 */
export type Env = {
  STORAGE: R2Bucket;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
};
