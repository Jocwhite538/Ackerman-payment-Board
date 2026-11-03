using System.Text.Json;
using System.Text.Json.Nodes;
using Ackerman.PaymentBoard.Data;
using Ackerman.PaymentBoard.Models;
using LiteDB;

namespace Ackerman.PaymentBoard.Services;

public sealed class LiteDbPatientStore : IPatientStore
{
    public const string LegacyBoardMigrationId = "per-patient-records-v3.3";

    private readonly ILiteDatabase _db;
    private readonly ILiteCollection<PatientRecord> _patients;
    private readonly ILiteCollection<PatientRevision> _history;
    private readonly ILiteCollection<MigrationRecord> _migrations;
    private readonly object _gate = new();
    private long _lastSeq;

    public LiteDbPatientStore(DatabaseFactory factory)
    {
        _db = factory.Database;
        _patients = _db.GetCollection<PatientRecord>("patients");
        _history = _db.GetCollection<PatientRevision>("patient_history");
        _migrations = _db.GetCollection<MigrationRecord>("migrations");
        _patients.EnsureIndex(x => x.Seq);
        _patients.EnsureIndex(x => x.Mrn);
        _history.EnsureIndex(x => x.PatientId);

        var latest = _patients.Query().OrderByDescending(x => x.Seq).Limit(1).ToList().FirstOrDefault();
        _lastSeq = latest?.Seq ?? 0;
    }

    public long CurrentSeq => Interlocked.Read(ref _lastSeq);

    public IReadOnlyList<PatientRecord> List() => _patients.FindAll().ToList();

    public IReadOnlyList<PatientRecord> ChangedSince(long seq)
        => _patients.Query().Where(x => x.Seq > seq).OrderBy(x => x.Seq).ToList();

    public PatientRecord? Get(string id) => _patients.FindById(id);

    public IReadOnlyList<PatientRevision> History(string id)
        => !IsValidId(id)
            ? Array.Empty<PatientRevision>()
            : _history.Query().Where(x => x.PatientId == id).OrderByDescending(x => x.Revision).ToList()
                .Where(x => string.Equals(x.PatientId, id, StringComparison.Ordinal)).ToList();

    public PatientRevision? GetRevision(string id, long revision)
        => !IsValidId(id) ? null : _history.Query().Where(x => x.PatientId == id && x.Revision == revision).ToList()
            .FirstOrDefault(x => string.Equals(x.PatientId, id, StringComparison.Ordinal));

    /// <summary>
    /// LiteDB trims stored strings (including ids) and compares ids without regard to
    /// case, so only ids that survive both unchanged are accepted.
    /// </summary>
    public static bool IsValidId(string? id)
        => !string.IsNullOrEmpty(id) &&
           id.Length <= 200 &&
           string.Equals(id, id.Trim(), StringComparison.Ordinal) &&
           !id.Any(char.IsControl);

    public PatientSaveResult Save(string id, long expectedRevision, string username, Func<PatientRecord?, PatientPrepareResult> prepare)
    {
        lock (_gate)
        {
            if (!IsValidId(id))
                return new PatientSaveResult { Status = PatientSaveStatus.Rejected, Error = "Invalid patient id." };

            var current = _patients.FindById(id);
            // LiteDB id lookups ignore case; never let "ABC" reach the record stored as "abc".
            if (current is not null && !string.Equals(current.Id, id, StringComparison.Ordinal))
                return new PatientSaveResult { Status = PatientSaveStatus.Rejected, Error = "Invalid patient id." };

            var currentRevision = current?.Revision ?? 0;
            if (currentRevision != expectedRevision)
                return new PatientSaveResult { Status = PatientSaveStatus.Conflict, Current = current };

            var prepared = prepare(current);
            if (prepared.Error is not null || prepared.Patient is null)
                return new PatientSaveResult { Status = PatientSaveStatus.Rejected, Current = current, Error = prepared.Error ?? "The patient could not be saved." };

            var patient = prepared.Patient;
            var mrn = patient.Mrn;
            // Checked only when the MRN is new or changed, so patients that already shared
            // an MRN before Version 3.3 can still be saved (the migration summary lists them).
            if (!string.IsNullOrEmpty(mrn) &&
                !string.Equals(current?.Mrn ?? "", mrn, StringComparison.Ordinal) &&
                _patients.Find(x => x.Mrn == mrn).Any(x => !string.Equals(x.Id, id, StringComparison.Ordinal)))
            {
                return new PatientSaveResult
                {
                    Status = PatientSaveStatus.Rejected,
                    Current = current,
                    Error = "That MRN is already used by another patient on the board."
                };
            }

            var now = DateTime.UtcNow;
            var nextSeq = CurrentSeq + 1;
            var record = current ?? new PatientRecord { Id = id, CreatedAtUtc = now, CreatedBy = username };
            var previousJson = current?.Json;
            record.Json = patient.Json;
            record.Name = patient.Name;
            record.Mrn = patient.Mrn;
            record.Revision = currentRevision + 1;
            record.Seq = nextSeq;
            record.UpdatedAtUtc = now;
            record.UpdatedBy = username;

            _db.BeginTrans();
            try
            {
                // Insert for a new patient, Update for an existing one: a key collision
                // then fails loudly instead of overwriting another patient.
                if (current is null) _patients.Insert(record);
                else if (!_patients.Update(record)) throw new InvalidOperationException($"Patient {id} could not be updated.");
                _history.Insert(new PatientRevision
                {
                    PatientId = id,
                    Revision = record.Revision,
                    Json = record.Json,
                    SavedAtUtc = now,
                    SavedBy = username
                });
                _db.Commit();
            }
            catch
            {
                _db.Rollback();
                throw;
            }

            // Publish the new sequence only after the commit, so a workstation that
            // reads CurrentSeq can never skip over a change that is not yet visible.
            Interlocked.Exchange(ref _lastSeq, nextSeq);
            return new PatientSaveResult
            {
                Status = PatientSaveStatus.Saved,
                Current = record,
                PreviousJson = previousJson,
                Warnings = prepared.Warnings
            };
        }
    }

    public string? MigrateLegacyBoard(AppStateDocument? legacy)
    {
        lock (_gate)
        {
            if (_migrations.FindById(LegacyBoardMigrationId) is not null) return null;

            var imported = 0;
            var demoRemoved = 0;
            var skippedIds = new List<string>();
            var mrnOwners = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            var seq = CurrentSeq;
            var now = DateTime.UtcNow;
            var legacyUser = string.IsNullOrWhiteSpace(legacy?.UpdatedBy) ? "Version 3.3 migration" : legacy!.UpdatedBy;

            _db.BeginTrans();
            try
            {
                if (legacy is not null && !string.IsNullOrWhiteSpace(legacy.PatientsJson))
                {
                    using var document = JsonDocument.Parse(legacy.PatientsJson);
                    // Stop rather than mark the migration done with nothing imported.
                    if (document.RootElement.ValueKind != JsonValueKind.Array)
                        throw new InvalidOperationException("The Version 3.2 board document is not a list of patients; the Version 3.3 migration was not applied.");

                    foreach (var item in document.RootElement.EnumerateArray())
                    {
                        var id = IdText(item);
                        var mrn = Text(item, "mrn").Trim();
                        if (item.ValueKind != JsonValueKind.Object || id.Length == 0)
                        {
                            skippedIds.Add(id.Length == 0 ? "(no id)" : id);
                            continue;
                        }
                        // Version 3.2 removed demo patients in the browser on every load.
                        // Version 3.3 does it once, here, on the server.
                        if (id.StartsWith("demo-", StringComparison.OrdinalIgnoreCase) ||
                            mrn.StartsWith("DEMO-", StringComparison.OrdinalIgnoreCase))
                        {
                            demoRemoved++;
                            continue;
                        }
                        if (!IsValidId(id) || _patients.FindById(id) is not null)
                        {
                            skippedIds.Add(id);
                            continue;
                        }

                        seq++;
                        // Store in the same canonical form that later saves use, so the
                        // first save does not look like a change to every field.
                        // The id is always stored as a string, matching what the board sends back.
                        var node = JsonNode.Parse(item.GetRawText())!;
                        node["id"] = id;
                        var json = node.ToJsonString();
                        if (mrn.Length > 0)
                        {
                            var key = mrn.ToUpperInvariant();
                            if (!mrnOwners.TryGetValue(key, out var owners)) mrnOwners[key] = owners = new List<string>();
                            owners.Add(id);
                        }
                        _patients.Insert(new PatientRecord
                        {
                            Id = id,
                            Json = json,
                            Revision = 1,
                            Seq = seq,
                            Name = Text(item, "name"),
                            Mrn = mrn.ToUpperInvariant(),
                            CreatedAtUtc = now,
                            CreatedBy = "Version 3.3 migration",
                            UpdatedAtUtc = legacy.UpdatedAtUtc,
                            UpdatedBy = legacyUser
                        });
                        _history.Insert(new PatientRevision
                        {
                            PatientId = id,
                            Revision = 1,
                            Json = json,
                            SavedAtUtc = now,
                            SavedBy = "Version 3.3 migration"
                        });
                        imported++;
                    }
                }

                // Patient ids, not MRNs, so the summary carries no patient identifiers.
                var sharedMrnPatients = mrnOwners.Values.Where(x => x.Count > 1).SelectMany(x => x).ToList();
                var summary = $"Imported {imported} patients from the Version 3.2 board (revision {legacy?.Revision ?? 0}); removed {demoRemoved} demo patients; skipped {skippedIds.Count} unreadable or duplicate entries" +
                              (skippedIds.Count > 0 ? $" (ids: {string.Join(", ", skippedIds.Take(20))})" : "") +
                              (sharedMrnPatients.Count > 0 ? $"; {sharedMrnPatients.Count} patients share an MRN with another patient (ids: {string.Join(", ", sharedMrnPatients.Take(20))})" : "") +
                              ". The original board document was kept unchanged as a backup.";
                _migrations.Insert(new MigrationRecord { Id = LegacyBoardMigrationId, AppliedAtUtc = now, Details = summary });
                _db.Commit();
                Interlocked.Exchange(ref _lastSeq, seq);
                return summary;
            }
            catch
            {
                _db.Rollback();
                throw;
            }
        }
    }

    private static string IdText(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty("id", out var value)) return "";
        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString() ?? "",
            JsonValueKind.Number => value.GetRawText(),
            _ => ""
        };
    }

    private static string Text(JsonElement element, string property)
        => element.ValueKind == JsonValueKind.Object &&
           element.TryGetProperty(property, out var value) &&
           value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";
}
