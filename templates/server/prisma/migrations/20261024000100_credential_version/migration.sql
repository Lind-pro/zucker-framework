-- Password changes from every supported user-management path invalidate sessions
-- and outstanding reset tickets, including writes through the generic admin API.
CREATE FUNCTION enforce_account_credential_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."credentialVersion" := GREATEST(NEW."credentialVersion", OLD."credentialVersion");
  IF NEW."password" IS DISTINCT FROM OLD."password" THEN
    NEW."credentialVersion" := GREATEST(NEW."credentialVersion", OLD."credentialVersion" + 1);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER account_credential_version
BEFORE UPDATE ON "users"
FOR EACH ROW EXECUTE FUNCTION enforce_account_credential_version();
