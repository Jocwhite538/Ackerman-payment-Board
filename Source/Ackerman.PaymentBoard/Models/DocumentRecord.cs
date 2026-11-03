namespace Ackerman.PaymentBoard.Models;

public sealed class DocumentRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string PatientId { get; set; } = "";
    public string Name { get; set; } = "";
    public string ContentType { get; set; } = "application/octet-stream";
    public long Size { get; set; }
    public DateTime AddedAtUtc { get; set; } = DateTime.UtcNow;
    public string AddedBy { get; set; } = "";
    public string FileStorageId { get; set; } = "";
}
