-- Schéma SQL optionnel pour persister les conversations et la base de connaissances

CREATE TABLE chat_logs (
  id SERIAL PRIMARY KEY,
  rid VARCHAR(20) NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sources TEXT[],
  actions TEXT[],
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE knowledge_documents (
  id SERIAL PRIMARY KEY,
  source TEXT UNIQUE NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
