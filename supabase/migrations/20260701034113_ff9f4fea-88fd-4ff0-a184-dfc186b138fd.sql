SELECT cron.schedule(
  'central-core-apify-immobiliare-nightly',
  '10 3 * * *',
  $$
  SELECT net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-apify-immobiliare-nightly',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpwdW5uemdpeGNnaHV5ZHN0ZGx0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIzMDE1NzcsImV4cCI6MjA4Nzg3NzU3N30.aZSVcHq76DGZv0Ka_p0tdwvSSn-2TAECrgXFCrs5ECQ'
    ),
    body := jsonb_build_object(
      'trigger','cron-nightly-0310',
      'max_urls_from_db', 200,
      'max_items', 200,
      'wait_seconds', 300,
      'dry_run', false
    ),
    timeout_milliseconds := 10000
  ) AS request_id;
  $$
);