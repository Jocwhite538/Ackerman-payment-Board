using Ackerman.PaymentBoard.Models;

namespace Ackerman.PaymentBoard.Services;

public interface IUserStore
{
    int Count();
    IReadOnlyList<AppUser> List();
    AppUser? FindById(string id);
    AppUser? FindByUsername(string username);
    void Upsert(AppUser user);
}

public interface IAuditStore
{
    void Add(AuditEntry entry);
    IReadOnlyList<AuditEntry> Recent(int take = 250);
}

public interface IApplicationStateStore
{
    AppStateDocument? Get();
    bool TrySave(string patientsJson, long expectedRevision, string username, out AppStateDocument saved);
}

public enum PatientSaveStatus
{
    Saved,
    Conflict,
    Rejected
}

/// <summary>The checked, server-stamped version of a patient that is ready to store.</summary>
public sealed record PreparedPatient(string Json, string Name, string Mrn);

public sealed record PatientPrepareResult(PreparedPatient? Patient, string? Error, IReadOnlyList<string> Warnings)
{
    public static PatientPrepareResult Fail(string error) => new(null, error, Array.Empty<string>());
}

public sealed class PatientSaveResult
{
    public PatientSaveStatus Status { get; init; }

    /// <summary>The saved record, or on a conflict the newer record currently on the server (null if none).</summary>
    public PatientRecord? Current { get; init; }

    /// <summary>The patient JSON before this save (null for a new patient).</summary>
    public string? PreviousJson { get; init; }

    public string? Error { get; init; }
    public IReadOnlyList<string> Warnings { get; init; } = Array.Empty<string>();
}

public interface IPatientStore
{
    /// <summary>The highest change sequence that has been committed.</summary>
    long CurrentSeq { get; }

    IReadOnlyList<PatientRecord> List();
    IReadOnlyList<PatientRecord> ChangedSince(long seq);
    PatientRecord? Get(string id);
    IReadOnlyList<PatientRevision> History(string id);
    PatientRevision? GetRevision(string id, long revision);

    /// <summary>
    /// Saves one patient if <paramref name="expectedRevision"/> matches the stored revision
    /// (0 = the patient must not exist yet). <paramref name="prepare"/> runs inside the save
    /// lock with the stored record so ledger checks cannot race another save.
    /// </summary>
    PatientSaveResult Save(string id, long expectedRevision, string username, Func<PatientRecord?, PatientPrepareResult> prepare);

    /// <summary>
    /// One-time copy of the Version 3.2 single-document board into per-patient records.
    /// Returns a summary when it ran, or null if it had already been applied.
    /// </summary>
    string? MigrateLegacyBoard(AppStateDocument? legacy);
}

public interface IDocumentStore
{
    IReadOnlyList<DocumentRecord> List(string patientId);
    DocumentRecord Add(string patientId, string name, string contentType, byte[] bytes, string username);
    (DocumentRecord Meta, byte[] Bytes)? Get(string id);
    bool Delete(string id);
}
