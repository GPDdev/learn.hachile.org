PRAGMA foreign_keys = ON;
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  invited INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL
);
CREATE TABLE codes (email TEXT PRIMARY KEY, hash TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE limits (bucket TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE quotes (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), topic TEXT NOT NULL,
  kind TEXT NOT NULL, level TEXT NOT NULL, lesson TEXT NOT NULL, seconds INTEGER NOT NULL,
  price INTEGER NOT NULL, created INTEGER NOT NULL
);
CREATE INDEX quotes_owner ON quotes(user_id,created);
CREATE TABLE costs (id TEXT PRIMARY KEY, ceiling_fen INTEGER NOT NULL CHECK (ceiling_fen > 0), created INTEGER NOT NULL);
CREATE TRIGGER enforce_pilot_budget BEFORE INSERT ON costs
WHEN (SELECT COALESCE(SUM(ceiling_fen),0) FROM costs) + NEW.ceiling_fen > 5000
BEGIN SELECT RAISE(ABORT,'pilot_budget'); END;
CREATE TABLE ledger (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  wallet TEXT NOT NULL CHECK(wallet IN ('learn','sandbox')), amount INTEGER NOT NULL,
  note TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE INDEX ledger_owner ON ledger(user_id,wallet);
CREATE TRIGGER sufficient_funds BEFORE INSERT ON ledger
WHEN NEW.amount < 0 AND (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE user_id=NEW.user_id AND wallet=NEW.wallet)+NEW.amount < 0
BEGIN SELECT RAISE(ABORT,'insufficient_credits'); END;
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id), user_id TEXT NOT NULL REFERENCES users(id),
  price INTEGER NOT NULL, cost_fen INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'queued'
    CHECK(state IN ('queued','dispatched','rendering','ready','failed')),
  run_id TEXT, sent INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, deadline INTEGER NOT NULL,
  media_bytes INTEGER NOT NULL DEFAULT 0, duration REAL, problem TEXT,
  published INTEGER, blocked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX jobs_owner ON jobs(user_id,created);
CREATE INDEX jobs_public ON jobs(published) WHERE published IS NOT NULL;
CREATE INDEX jobs_pending ON jobs(state,deadline);
CREATE TRIGGER reserve_job AFTER INSERT ON jobs BEGIN
  INSERT INTO ledger VALUES ('hold:'||NEW.id,NEW.user_id,'learn',-NEW.price,'生成视频预留',NEW.created);
  INSERT INTO costs VALUES ('render:'||NEW.id,NEW.cost_fen,NEW.created);
END;
CREATE TRIGGER release_job AFTER UPDATE OF state ON jobs
WHEN NEW.state='failed' AND OLD.state IN ('queued','dispatched','rendering') BEGIN
  INSERT INTO ledger VALUES ('release:'||NEW.id,NEW.user_id,'learn',NEW.price,'生成失败退回',unixepoch());
END;
CREATE TABLE orders (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), mode TEXT NOT NULL,
  fen INTEGER NOT NULL CHECK(fen > 0), credits INTEGER NOT NULL CHECK(credits > 0),
  state TEXT NOT NULL DEFAULT 'pending', trade TEXT UNIQUE, created INTEGER NOT NULL
);
CREATE INDEX orders_owner ON orders(user_id,created);
CREATE TRIGGER deposit_paid_order AFTER UPDATE OF state ON orders
WHEN OLD.state='pending' AND NEW.state='paid' BEGIN
  INSERT INTO ledger VALUES ('order:'||NEW.id,NEW.user_id,CASE WHEN NEW.mode='live' THEN 'learn' ELSE 'sandbox' END,
    NEW.credits,CASE WHEN NEW.mode='live' THEN '支付宝充值' ELSE '测试充值' END,unixepoch());
END;
CREATE TRIGGER grant_invite AFTER UPDATE OF invited ON users WHEN OLD.invited=0 AND NEW.invited=1 BEGIN
  INSERT INTO ledger VALUES ('invite:'||NEW.id,NEW.id,'learn',60,'内测邀请额度',unixepoch());
END;
CREATE TABLE reports (
  job_id TEXT NOT NULL REFERENCES jobs(id), user_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(job_id,user_id)
);
