namespace Ackerman.PaymentBoard.Models;

/// <summary>
/// One patient on the shared board. Version 3.3 stores each patient as its own
/// record with its own revision number, so two people working on different
/// patients never block each other.
/// </summary>
public sealed class PatientRecord
{
    public string Id { get; set; } = "";

    /// <summary>The patient document exactly as the board uses it (JSON object).</summary>
    public string Json { get; set; } = "{}";

    /// <summary>Per-patient revision. Starts at 1 and increases by one on every save.</summary>
    public long Revision { get; set; }

    /// <summary>Board-wide change sequence, used by workstations to fetch "what changed since".</summary>
    public long Seq { get; set; }

    public string Name { get; set; } = "";

    /// <summary>Upper-cased MRN, used to prevent two patients with the same MRN.</summary>
    public string Mrn { get; set; } = "";

    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
    public string CreatedBy { get; set; } = "";
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;
    public string UpdatedBy { get; set; } = "";
}

/// <summary>
/// Every saved version of every patient. Nothing in the application deletes
/// these, so any earlier state of a patient can be recovered.
/// </summary>
public sealed class PatientRevision
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string PatientId { get; set; } = "";
    public long Revision { get; set; }
    public string Json { get; set; } = "{}";
    public DateTime SavedAtUtc { get; set; } = DateTime.UtcNow;
    public string SavedBy { get; set; } = "";
}

public sealed class MigrationRecord
{
    public string Id { get; set; } = "";
    public DateTime AppliedAtUtc { get; set; } = DateTime.UtcNow;
    public string Details { get; set; } = "";
}
