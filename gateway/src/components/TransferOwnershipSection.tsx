import SwapHoriz from "@mui/icons-material/SwapHoriz";
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  MenuItem,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import { useAuth } from "../data/AuthContext";
import { type Member, type OwnershipKind, fetchMembers, transferOwnership } from "../data/api";

interface Props {
  kind: OwnershipKind;
  resourceId: string;
  resourceLabel: string;
  ownerId: string | null;
  onTransferred: () => void;
}

const LABELS: Record<OwnershipKind, string> = {
  agent: "agent",
  room: "room",
  package: "package",
  reference: "reference",
  reference_type: "reference type",
  document: "document",
  template: "template",
};

/** Hands the thing to another member of this workspace. The server decides
 * who may and refuses what can't be moved; its message is shown as is. */
export default function TransferOwnershipSection({
  kind,
  resourceId,
  resourceLabel,
  ownerId,
  onTransferred,
}: Props) {
  const { session } = useAuth();
  const tenantId = session?.tenant?.id;
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [recipient, setRecipient] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = LABELS[kind];

  useEffect(() => {
    if (!open || !tenantId) return;
    let cancelled = false;
    fetchMembers(tenantId)
      .then((found) => {
        if (!cancelled) setMembers(found);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load members");
      });
    return () => {
      cancelled = true;
    };
  }, [open, tenantId]);

  const close = () => {
    if (submitting) return;
    setOpen(false);
    setRecipient("");
    setError(null);
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await transferOwnership(kind, resourceId, recipient);
      setOpen(false);
      onTransferred();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The transfer failed");
    } finally {
      setSubmitting(false);
    }
  };

  const candidates = (members ?? []).filter((m) => m.user_id !== ownerId);

  return (
    <Stack spacing={1}>
      <Typography variant="overline" sx={{ display: "block" }}>
        Ownership
      </Typography>
      <Button
        variant="outlined"
        startIcon={<SwapHoriz />}
        onClick={() => setOpen(true)}
        sx={{ alignSelf: "flex-start" }}
      >
        Transfer ownership
      </Button>
      <Dialog open={open} onClose={close} fullWidth maxWidth="xs">
        <DialogTitle>Transfer {label}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Make another member of this workspace the owner of <b>{resourceLabel}</b>.
          </DialogContentText>
          {kind === "agent" && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              The agent gets a new API key that only the new owner can see. It stops
              working with the old key until it is reconnected.
            </Alert>
          )}
          {members === null && !error ? (
            <CircularProgress size={20} />
          ) : (
            <Select
              fullWidth
              size="small"
              displayEmpty
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              aria-label="New owner"
            >
              <MenuItem value="" disabled>
                Choose a member
              </MenuItem>
              {candidates.map((m) => (
                <MenuItem key={m.user_id} value={m.user_id}>
                  {m.name} ({m.email})
                </MenuItem>
              ))}
            </Select>
          )}
          {error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={submit}
            disabled={submitting || recipient === ""}
            startIcon={submitting ? <CircularProgress size={16} /> : undefined}
          >
            Transfer
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
