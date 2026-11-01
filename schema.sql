-- Chase Your Taxes schema (PostgreSQL)
-- Run this in your Render Postgres database

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  username VARCHAR(50) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  city VARCHAR(100),
  state VARCHAR(50),
  county VARCHAR(100),
  zip VARCHAR(20),
  role VARCHAR(20) DEFAULT 'user',
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jurisdictions (
  id SERIAL PRIMARY KEY,
  city VARCHAR(100),
  county VARCHAR(100),
  state VARCHAR(50),
  zip VARCHAR(20),
  display_name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (city, county, state, zip)
);

CREATE TABLE IF NOT EXISTS tax_types (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  level VARCHAR(50),
  is_locked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  description TEXT,
  source_type VARCHAR(50),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tax_items (
  id SERIAL PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  tax_type_id INTEGER REFERENCES tax_types(id),
  jurisdiction_id INTEGER REFERENCES jurisdictions(id),
  amount DECIMAL(12,2) NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO tax_types (name, level) VALUES
  ('Federal Income Tax', 'federal'),
  ('Social Security (FICA)', 'federal'),
  ('Medicare (FICA)', 'federal'),
  ('Florida State Sales Tax', 'state'),
  ('Local Option Sales Tax', 'county')
ON CONFLICT DO NOTHING;
