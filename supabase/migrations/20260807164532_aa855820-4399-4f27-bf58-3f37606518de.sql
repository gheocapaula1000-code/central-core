-- Il ricalcolo Civiko dei contendibili (già eseguito senza limiti dal job
-- notturno in-DB) supera gli 8s ereditati da authenticator quando viene
-- invocato via PostgREST con service_role, causando 57014 → HTTP 500.
-- service_role è esclusivamente server-side (mai esposto al client): alzare il
-- solo tetto massimo non modifica dati, policy, zone o comportamenti esistenti.
ALTER ROLE service_role SET statement_timeout = '120s';