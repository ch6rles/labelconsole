-- Reference data for distributor inference: the label / P-line strings each
-- distributor puts on releases. Matched case-insensitively as substrings.
-- Labels confirm or correct guesses per org in distributor_hints.
INSERT INTO distributor_aliases (distributor, pattern, weight) VALUES
  ('DistroKid', 'distrokid', 0.9),
  ('DistroKid', 'records dk', 0.85),
  ('TuneCore', 'tunecore', 0.9),
  ('CD Baby', 'cd baby', 0.9),
  ('CD Baby', 'cdbaby', 0.9),
  ('Amuse', 'amuse', 0.6),
  ('UnitedMasters', 'unitedmasters', 0.9),
  ('AWAL', 'awal', 0.85),
  ('The Orchard', 'the orchard', 0.85),
  ('Believe', 'believe', 0.6),
  ('Symphonic', 'symphonic', 0.75),
  ('Ditto Music', 'ditto', 0.6),
  ('RouteNote', 'routenote', 0.9),
  ('FUGA', 'fuga', 0.7),
  ('EMPIRE', 'empire', 0.6),
  ('ONErpm', 'onerpm', 0.9),
  ('Vydia', 'vydia', 0.9),
  ('Too Lost', 'too lost', 0.85),
  ('Stem', 'stem disintermedia', 0.9),
  ('Create Music Group', 'create music group', 0.9),
  ('Virgin Music Group', 'virgin music', 0.7),
  ('Level', 'level music', 0.6),
  ('Spinnup', 'spinnup', 0.9),
  ('EmuBands', 'emubands', 0.9),
  ('Ingrooves', 'ingrooves', 0.85),
  ('Absolute Label Services', 'absolute label services', 0.9)
ON CONFLICT (distributor, pattern) DO NOTHING;
