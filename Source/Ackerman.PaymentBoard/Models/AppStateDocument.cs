namespace Ackerman.PaymentBoard.Models;

public sealed class AppStateDocument
{
    public string Id { get; set; } = "main";
    public string PatientsJson { get; set; } = "[]";
    public long Revision { get; set; }
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;
    public string UpdatedBy { get; set; } = "system";
}

public sealed class StateEnvelope
{
    public long Revision { get; set; }
    public object? Patients { get; set; }
}
