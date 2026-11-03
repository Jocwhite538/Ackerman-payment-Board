using System.Security.Claims;
using System.Text.Json;
using Ackerman.PaymentBoard.Models;
using Ackerman.PaymentBoard.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Mvc;

namespace Ackerman.PaymentBoard.Controllers;

[Authorize]
public sealed class ApiController : ControllerBase
{
    private readonly IPatientStore _patients;
    private readonly IDocumentStore _documents;
    private readonly AuditService _audit;
    private readonly StateAuditDiffService _diff;
    private readonly PatientLedgerGuard _guard;
    private readonly ILogger<ApiController> _logger;

    public ApiController(IPatientStore patients, IDocumentStore documents, AuditService audit, StateAuditDiffService diff, PatientLedgerGuard guard, ILogger<ApiController> logger)
    {
        _logger = logger;
        _patients = patients;
        _documents = documents;
        _audit = audit;
        _diff = diff;
        _guard = guard;
    }


    [HttpGet("api/antiforgery")]
    public IActionResult Antiforgery([FromServices] IAntiforgery antiforgery)
    {
        var tokens = antiforgery.GetAndStoreTokens(HttpContext);
        return Ok(new { token = tokens.RequestToken });
    }

    [HttpGet("api/session")]
    public IActionResult SessionInfo() => Ok(new
    {
        username = User.Identity?.Name,
        role = User.FindFirstValue(ClaimTypes.Role),
        isSuperUser = User.IsInRole(Roles.SuperUser)
    });

    // ---------------------------------------------------------------------
    // Patients (Version 3.3): one record per patient, each with its own revision.
    // ---------------------------------------------------------------------

    [HttpGet("api/patients")]
    public IActionResult ListPatients()
    {
        // Read the sequence first: anything saved after this point is returned by
        // the next /api/patients/changes call, so nothing can be missed.
        var seq = _patients.CurrentSeq;
        var records = _patients.List();
        return Ok(new { seq, patients = records.Select(ToDto).ToList() });
    }

    [HttpGet("api/patients/changes")]
    public IActionResult PatientChanges([FromQuery] long since = 0)
    {
        var seq = _patients.CurrentSeq;
        IReadOnlyList<PatientRecord> changed = since >= seq ? Array.Empty<PatientRecord>() : _patients.ChangedSince(since);
        return Ok(new { seq, patients = changed.Select(ToDto).ToList() });
    }

    public sealed class SavePatientRequest
    {
        public long Revision { get; set; }
        public JsonElement Patient { get; set; }
    }

    [ValidateAntiForgeryToken, HttpPut("api/patients/{id}")]
    public IActionResult SavePatient(string id, [FromBody] SavePatientRequest? request)
    {
        if (!LiteDbPatientStore.IsValidId(id)) return BadRequest(new { message = "Invalid patient id." });
        if (request is null || request.Patient.ValueKind != JsonValueKind.Object)
            return BadRequest(new { message = "The patient could not be read from the request." });

        var username = User.Identity?.Name ?? "unknown";
        var result = _patients.Save(id, request.Revision, username,
            current => _guard.Prepare(id, current?.Json, request.Patient, username, DateTime.UtcNow));

        if (result.Status == PatientSaveStatus.Conflict)
        {
            var current = result.Current;
            return Conflict(new
            {
                message = "This patient was changed on another workstation.",
                revision = current?.Revision ?? 0,
                updatedBy = current?.UpdatedBy,
                updatedAtUtc = current?.UpdatedAtUtc,
                patient = current is null ? (JsonElement?)null : ParseJson(current.Json)
            });
        }

        if (result.Status == PatientSaveStatus.Rejected)
        {
            _audit.Write("Patient save refused", "Patient", id, result.Error ?? "");
            return BadRequest(new { message = result.Error ?? "The patient could not be saved." });
        }

        var saved = result.Current!;
        // The save is committed. If writing the audit description fails, still report
        // success: answering with an error now would make the user re-enter a payment
        // that is already recorded.
        try
        {
            var change = _diff.ComparePatient(id, result.PreviousJson, saved.Json);
            _audit.Write(change.Action, "Patient", id, $"{change.Details} (revision {saved.Revision})");
            foreach (var warning in result.Warnings)
                _audit.Write("Ledger change refused", "Patient", id, warning);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Patient {PatientId} revision {Revision} was saved but its audit entry could not be written.", id, saved.Revision);
        }

        return Ok(new
        {
            revision = saved.Revision,
            updatedBy = saved.UpdatedBy,
            updatedAtUtc = saved.UpdatedAtUtc,
            patient = ParseJson(saved.Json),
            warnings = result.Warnings
        });
    }

    [Authorize(Roles = Roles.SuperUser), HttpGet("api/patients/{id}/history")]
    public IActionResult PatientHistory(string id)
    {
        var history = _patients.History(id);
        if (history.Count == 0) return NotFound();
        _audit.Write("Patient history viewed", "Patient", id, $"{history.Count} saved versions listed");
        return Ok(history.Select(h => new { revision = h.Revision, savedAtUtc = h.SavedAtUtc, savedBy = h.SavedBy }).ToList());
    }

    [Authorize(Roles = Roles.SuperUser), HttpGet("api/patients/{id}/history/{revision:long}")]
    public IActionResult GetPatientRevision(string id, long revision)
    {
        var version = _patients.GetRevision(id, revision);
        if (version is null) return NotFound();
        _audit.Write("Patient history viewed", "Patient", id, $"Revision {revision} opened");
        return Ok(new { revision = version.Revision, savedAtUtc = version.SavedAtUtc, savedBy = version.SavedBy, patient = ParseJson(version.Json) });
    }

    // ---------------------------------------------------------------------
    // Version 3.2 whole-board endpoints, kept only so a browser still running
    // cached 3.2 JavaScript can display the board and is told to refresh.
    // ---------------------------------------------------------------------

    [HttpGet("api/state")]
    public IActionResult GetState()
    {
        var seq = _patients.CurrentSeq;
        var patients = _patients.List().Select(r => ParseJson(r.Json)).ToList();
        return Ok(new { revision = seq, patients });
    }

    [HttpPut("api/state")]
    public IActionResult SaveState()
        => Conflict(new
        {
            message = "The Payment Board was updated to Version 3.3. Refresh this page (Ctrl+F5) before making more changes.",
            updatedBy = "the Version 3.3 update"
        });

    private static object ToDto(PatientRecord record) => new
    {
        id = record.Id,
        revision = record.Revision,
        updatedBy = record.UpdatedBy,
        updatedAtUtc = record.UpdatedAtUtc,
        data = ParseJson(record.Json)
    };

    private static JsonElement ParseJson(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    [HttpGet("api/documents/patient/{patientId}")]
    public IActionResult ListDocuments(string patientId)
        => Ok(_documents.List(patientId).Select(d => new { id = d.Id, patientId = d.PatientId, name = d.Name, type = d.ContentType, size = d.Size, addedAt = d.AddedAtUtc, addedBy = d.AddedBy }));

    [RequestSizeLimit(10 * 1024 * 1024), ValidateAntiForgeryToken, HttpPost("api/documents/patient/{patientId}")]
    public async Task<IActionResult> UploadDocument(string patientId, IFormFile file)
    {
        if (file is null || file.Length <= 0) return BadRequest(new { message = "Choose a file." });
        if (file.Length > 10 * 1024 * 1024) return BadRequest(new { message = "File exceeds the 10 MB limit." });
        var allowedExtensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".txt", ".png", ".jpg", ".jpeg", ".webp"
        };
        var extension = Path.GetExtension(file.FileName);
        if (!allowedExtensions.Contains(extension)) return BadRequest(new { message = "That file type is not allowed." });
        using var ms = new MemoryStream();
        await file.CopyToAsync(ms);
        var record = _documents.Add(patientId, Path.GetFileName(file.FileName), file.ContentType, ms.ToArray(), User.Identity?.Name ?? "unknown");
        _audit.Write("Document attached", "Patient", patientId, record.Name);
        return Ok(new { id = record.Id, patientId = record.PatientId, name = record.Name, type = record.ContentType, size = record.Size, addedAt = record.AddedAtUtc, addedBy = record.AddedBy });
    }

    [HttpGet("api/documents/{id}")]
    public IActionResult DownloadDocument(string id, bool download = false)
    {
        var result = _documents.Get(id);
        if (result is null) return NotFound();
        var disposition = download ? result.Value.Meta.Name : null;
        return File(result.Value.Bytes, result.Value.Meta.ContentType, disposition, enableRangeProcessing: true);
    }

    [ValidateAntiForgeryToken, HttpDelete("api/documents/{id}")]
    public IActionResult DeleteDocument(string id)
    {
        var existing = _documents.Get(id);
        if (existing is null) return NotFound();
        if (!_documents.Delete(id)) return NotFound();
        _audit.Write("Document deleted", "Patient", existing.Value.Meta.PatientId, existing.Value.Meta.Name);
        return NoContent();
    }
}
