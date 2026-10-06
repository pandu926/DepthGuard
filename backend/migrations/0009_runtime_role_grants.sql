-- Production API/worker use a runtime role; migrations remain a separate operator action.
DO $$
BEGIN
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='depthguard_app') THEN
        GRANT USAGE ON SCHEMA public TO depthguard_app;
        GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO depthguard_app;
        GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO depthguard_app;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO depthguard_app;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO depthguard_app;
    END IF;
END $$;
