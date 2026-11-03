using Ackerman.PaymentBoard.Data;
using Ackerman.PaymentBoard.Models;
using LiteDB;

namespace Ackerman.PaymentBoard.Services;

public sealed class LiteDbUserStore : IUserStore
{
    private readonly ILiteCollection<AppUser> _users;

    public LiteDbUserStore(DatabaseFactory factory)
    {
        _users = factory.Database.GetCollection<AppUser>("users");
        _users.EnsureIndex(x => x.NormalizedUsername, unique: true);
    }

    public int Count() => _users.Count();
    public IReadOnlyList<AppUser> List() => _users.Query().OrderBy(x => x.Username).ToList();
    public AppUser? FindById(string id) => _users.FindById(id);
    public AppUser? FindByUsername(string username)
        => _users.FindOne(x => x.NormalizedUsername == Normalize(username));
    public void Upsert(AppUser user) => _users.Upsert(user);
    public static string Normalize(string username) => (username ?? "").Trim().ToUpperInvariant();
}

public sealed class LiteDbAuditStore : IAuditStore
{
    private readonly ILiteCollection<AuditEntry> _entries;
    public LiteDbAuditStore(DatabaseFactory factory)
    {
        _entries = factory.Database.GetCollection<AuditEntry>("audit");
        _entries.EnsureIndex(x => x.TimestampUtc);
    }
    public void Add(AuditEntry entry) => _entries.Insert(entry);
    public IReadOnlyList<AuditEntry> Recent(int take = 250)
        => _entries.Query().OrderByDescending(x => x.TimestampUtc).Limit(Math.Clamp(take, 1, 1000)).ToList();
}

public sealed class LiteDbApplicationStateStore : IApplicationStateStore
{
    private readonly ILiteCollection<AppStateDocument> _state;
    private readonly object _gate = new();

    public LiteDbApplicationStateStore(DatabaseFactory factory)
    {
        _state = factory.Database.GetCollection<AppStateDocument>("app_state");
    }

    public AppStateDocument? Get() => _state.FindById("main");

    public bool TrySave(string patientsJson, long expectedRevision, string username, out AppStateDocument saved)
    {
        lock (_gate)
        {
            var current = _state.FindById("main");
            if (current is null)
            {
                if (expectedRevision != 0)
                {
                    saved = new AppStateDocument();
                    return false;
                }
                saved = new AppStateDocument
                {
                    PatientsJson = patientsJson,
                    Revision = 1,
                    UpdatedAtUtc = DateTime.UtcNow,
                    UpdatedBy = username
                };
                _state.Upsert(saved);
                return true;
            }

            if (current.Revision != expectedRevision)
            {
                saved = current;
                return false;
            }

            current.PatientsJson = patientsJson;
            current.Revision++;
            current.UpdatedAtUtc = DateTime.UtcNow;
            current.UpdatedBy = username;
            _state.Update(current);
            saved = current;
            return true;
        }
    }
}

public sealed class LiteDbDocumentStore : IDocumentStore
{
    private readonly ILiteDatabase _db;
    private readonly ILiteCollection<DocumentRecord> _meta;

    public LiteDbDocumentStore(DatabaseFactory factory)
    {
        _db = factory.Database;
        _meta = _db.GetCollection<DocumentRecord>("documents");
        _meta.EnsureIndex(x => x.PatientId);
        _meta.EnsureIndex(x => x.AddedAtUtc);
    }

    public IReadOnlyList<DocumentRecord> List(string patientId)
        => _meta.Query().Where(x => x.PatientId == patientId).OrderByDescending(x => x.AddedAtUtc).ToList();

    public DocumentRecord Add(string patientId, string name, string contentType, byte[] bytes, string username)
    {
        var id = Guid.NewGuid().ToString("N");
        var storageId = $"documents/{id}";
        using var stream = new MemoryStream(bytes, writable: false);
        _db.FileStorage.Upload(storageId, name, stream);
        var record = new DocumentRecord
        {
            Id = id,
            PatientId = patientId,
            Name = name,
            ContentType = string.IsNullOrWhiteSpace(contentType) ? "application/octet-stream" : contentType,
            Size = bytes.LongLength,
            AddedAtUtc = DateTime.UtcNow,
            AddedBy = username,
            FileStorageId = storageId
        };
        _meta.Insert(record);
        return record;
    }

    public (DocumentRecord Meta, byte[] Bytes)? Get(string id)
    {
        var meta = _meta.FindById(id);
        if (meta is null) return null;
        if (_db.FileStorage.FindById(meta.FileStorageId) is null) return null;
        using var ms = new MemoryStream();
        _db.FileStorage.Download(meta.FileStorageId, ms);
        return (meta, ms.ToArray());
    }

    public bool Delete(string id)
    {
        var meta = _meta.FindById(id);
        if (meta is null) return false;
        _db.FileStorage.Delete(meta.FileStorageId);
        return _meta.Delete(id);
    }
}
