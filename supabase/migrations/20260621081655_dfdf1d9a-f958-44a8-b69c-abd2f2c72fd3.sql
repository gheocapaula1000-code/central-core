
CREATE OR REPLACE FUNCTION public._safe_int(p text)
RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path = public
AS $$
DECLARE
  s text;
  b bigint;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  s := regexp_replace(p, '[^0-9]', '', 'g');
  IF s = '' OR length(s) > 18 THEN RETURN NULL; END IF;
  b := s::bigint;
  IF b > 2147483647 OR b < -2147483648 THEN RETURN NULL; END IF;
  RETURN b::int;
END $$;
