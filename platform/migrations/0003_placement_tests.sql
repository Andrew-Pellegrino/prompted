-- Where test emails actually landed, recorded by hand. Delivery is not inbox placement.
CREATE TABLE placement_tests (
  id INTEGER PRIMARY KEY,
  tested_on TEXT NOT NULL,                 -- YYYY-MM-DD
  sender TEXT NOT NULL,                    -- the From address or provider used
  inbox TEXT NOT NULL,                     -- which kind of inbox: Gmail, Outlook, iCloud, University, ...
  result TEXT NOT NULL CHECK (result IN ('inbox','promotions','spam','missing')),
  note TEXT,
  actor TEXT NOT NULL, created_at TEXT NOT NULL
);
