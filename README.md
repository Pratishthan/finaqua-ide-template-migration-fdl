# finaqua-ide-template-migration-fdl

Generates **FinAqua batch job JSONs** from a Source-to-Silver (FDL) mapping workbook:

```
mapping.xlsx                     out/
  DataMapping  (one row per        bronze/s_<table>[_incr].json   source  -> staging
                FDL column)  ──▶   silver/<entity>[_incr].json    staging -> FDL entity
  Conditions   (joins/unions)      ddl.sql                        every table the jobs write
                                   connections.json               placeholders to fill at deploy
                                   coverage.md                    what was generated + sheet defects
```

The Finacle CDH Person workbook ([test/sample/FinacleCDH_Person_Mapping.xlsx](test/sample/FinacleCDH_Person_Mapping.xlsx))
uses the default sheet layout (`DataMapping`/`Conditions`, no `--layout` override needed) and
produces 28 staging tables, 25 FDL entities and 109 files. The Limits workbook
([test/sample/limits_canonical_native_mapping.xlsx](test/sample/limits_canonical_native_mapping.xlsx)),
whose tabs use `fdl_`-prefixed headers and needs `--layout layouts/fdl-prefixed.json`, produces 34
staging tables, 33 FDL entities and 137 files. Limits names its columns differently, so pass
`-b limits --watermark data_persistance_time --key-column business_column_value` as well. The jobs follow the templates in `reference/`, with the
same readers and writers, the Kafka error writer and the load-then-audit execplan. Facts and
dimensions are out of scope.

Read [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) before a first deployment.

## Quick start

```bash
pnpm install
pnpm run generate test/sample/FinacleCDH_Person_Mapping.xlsx ./out
```

Then read `out/coverage.md`. It lists every sheet defect, each against its cell.

## Commands

| Command | What it does |
|---|---|
| `pnpm run generate <workbook> <dest> [-e <entity>]` | Write the bundle, or only one FDL entity and its staging tables |
| `pnpm run inspect <workbook>` | List sheet issues |
| `pnpm run inspect <workbook> <entity\|s_table> [-i]` | Print one job's SQL (`-i` for the incremental variant) |
| `pnpm run verify:pg <dest> <postgres-url>` | `EXPLAIN` every generated query on a scratch Postgres database |
| `pnpm test` / `typecheck` / `check` / `build` | Tests, `tsc`, Biome, tsup |

| Option | Default | Meaning |
|---|---|---|
| `--source-db`, `--target-db` | `postgres` | `postgres`, `oracle`, `mysql` or `mssql` (driver, URL, quoting, concatenation) |
| `-b, --batch-name` | `CDH` | Batch name for `batch_run_detail` / `audit_log_detail` |
| `--staging-prefix` | `s_` | Staging table prefix |
| `--watermark` | `metadata_persisted_timestamp` | FDL column carrying the source change time |
| `--key-column` | `metadata_business_key_value` | FDL column holding the business key, used as the upsert key |

## Running a bundle

1. Run `ddl.sql` once on the target database.
2. Fill in `connections.json` (source = Limits DB, target = lake).
3. Insert a `batch_run_detail` row with `status = 'running'`. Without it, the jobs load nothing.
4. Run the Bronze jobs (they can run in parallel), then the Silver jobs.
5. Check that `audit_log_detail` has no rows with `recon_success_status = 'N'`, then close the run.
6. For later runs, use the `_incr` jobs with a new `batch_run_id` each time.

## How it works

- **Bronze** copies only the source columns the mapping needs, plus the standard
  `metadata_*` / `audit_*` columns, taken from the FDL rows that read the table
  (`_createdon` / `_modifiedon` are staged as `metadata_source_created_timestamp` /
  `metadata_persisted_timestamp`). A sheet without them gets `batch_run_id` and a
  concatenated `business_column_value` instead. The projection and the incremental filter run on the source.
- **Pipeline columns** (`##PIPELINEGENERATED`) are filled by the job:
  `metadata_batch_execution_id` = the running `batch_run_id`, `metadata_job_execution_id` = `0`,
  `audit_*_by` = `'DataUser'`, `audit_*_timestamp` = `current_timestamp`, `audit_deleted_indicator` = `'N'`.
- **Silver** builds one query per entity from `DataMapping` (projections) and
  `Conditions` (`JOIN` / `UNION`) against staging. Table references in the rules are
  rewritten token by token, so string literals are never changed.
- **Casts** are added only when the kind of value changes. For example, `jsonb ->>` becomes `numeric`, and
  `bool` becomes `Y`/`N`. A narrowing `varchar` gets no cast, so Postgres raises an error instead of truncating.
- **Incremental** jobs pick up rows where any contributing table changed since the
  last audited watermark. They upsert on the key column with a `ts` guard
  (single-table jobs only).
- **Audit:** each job writes one `audit_log_detail` row comparing source and target
  counts for that run, per layer.
- **Validation:** sheet problems are reported in `coverage.md` as error, warning or note, and are never
  silently patched.

## Status

`verify:pg` plans 856 of 872 queries cleanly. The 16 failures come from sheet errors in
`category_limits` and `daywise_limit_balance`. An end-to-end Postgres run (full load,
then incremental) has been confirmed to load, upsert and reconcile correctly.

Known gaps:
- `jsonb[]` columns (about 10) cannot be bound by the writer. The real source type needs confirming.
- Rows with a NULL watermark are never updated incrementally.
- Joined entities have no `ts` guard, so a late delta can overwrite a newer row.
- The queries are checked in Postgres, not in Spark.

## Code layout

```
src/Mapping/
  parse.ts     workbook -> MappingSpec
  plan.ts      MappingSpec -> staging tables, FDL entities, issues
  sql.ts       token-level SQL rewriting
  dialect.ts   database types, quoting, concatenation
  finaqua.ts   plan -> job JSON (shared skeleton for bronze and silver)
  ddl.ts       plan -> DDL
  emit.ts      writes the bundle and coverage.md
src/scripts/verify-postgres.ts
src/index.ts   CLI
test/sample/ example workbooks: FinacleCDH_Person_Mapping.xlsx (default layout),
             limits_canonical_native_mapping.xlsx (fdl_-prefixed layout)
```
