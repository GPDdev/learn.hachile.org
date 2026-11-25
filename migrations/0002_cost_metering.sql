ALTER TABLE costs ADD COLUMN settled_fen INTEGER CHECK(settled_fen>=0);
ALTER TABLE costs ADD COLUMN usage TEXT;
CREATE TABLE cost_budget (id INTEGER PRIMARY KEY CHECK(id=1), cap_fen INTEGER NOT NULL CHECK(cap_fen>0), paused INTEGER NOT NULL DEFAULT 0);
-- The other 500 fen are allocated to the single opt-in local cloud-model trial.
INSERT INTO cost_budget(id, cap_fen) VALUES (1, 4500);
DROP TRIGGER enforce_pilot_budget;
CREATE TRIGGER enforce_pilot_budget BEFORE INSERT ON costs
WHEN (SELECT paused FROM cost_budget WHERE id=1)=1 OR
  (SELECT COALESCE(SUM(COALESCE(settled_fen,ceiling_fen)),0) FROM costs)+NEW.ceiling_fen > (SELECT cap_fen FROM cost_budget WHERE id=1)
BEGIN SELECT RAISE(ABORT,'pilot_budget'); END;
CREATE TRIGGER pause_overrun AFTER UPDATE OF settled_fen ON costs
WHEN NEW.settled_fen>NEW.ceiling_fen BEGIN UPDATE cost_budget SET paused=1 WHERE id=1; END;
DROP TRIGGER reserve_job;
CREATE TRIGGER reserve_job AFTER INSERT ON jobs BEGIN
  INSERT INTO ledger VALUES ('hold:'||NEW.id,NEW.user_id,'learn',-NEW.price,'生成视频预留',NEW.created);
  INSERT INTO costs(id,ceiling_fen,created)
    SELECT 'render:'||NEW.id,NEW.cost_fen,NEW.created WHERE NEW.cost_fen>0;
END;
