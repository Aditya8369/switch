import { Alert, Box, CircularProgress, Snackbar, Stack, Typography } from "@mui/material";
import { useState } from "react";
import { useAuth } from "../../data/AuthContext";
import { useConnectorApps } from "../../data/hooks";
import ConnectorAppCard from "./ConnectorAppCard";
import { cardOrder, ONLY_THE_OPERATOR, PUBLIC_URL_BANNER, REGISTERED_NOTE } from "./connectorApps";

function Heading() {
  return (
    <Box mb={2}>
      <Typography variant="h5">Connectors</Typography>
      <Typography variant="body2" color="text.secondary">
        Some connectors sign in through an app you register at the vendor. Set each up once,
        for the whole server, before anyone can connect it.
      </Typography>
    </Box>
  );
}

function ConnectorAppsList() {
  const { data, loading, error, refetch } = useConnectorApps();
  const [checkFailures, setCheckFailures] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);

  if (loading && data === null) return <CircularProgress />;
  if (error !== null) return <Alert severity="error">{error}</Alert>;
  if (data === null) return null;

  const missingUrl = data.public_url === null;
  return (
    <Stack spacing={2}>
      {missingUrl && <Alert severity="warning">{PUBLIC_URL_BANNER}</Alert>}
      {cardOrder(data.apps, checkFailures).map((app) => (
        <ConnectorAppCard
          key={app.slug}
          app={app}
          setupDisabled={missingUrl}
          checkFailure={checkFailures[app.slug] ?? null}
          onCheckFailure={(message) =>
            setCheckFailures((current) => {
              const next = { ...current };
              if (message === null) delete next[app.slug];
              else next[app.slug] = message;
              return next;
            })
          }
          onChanged={(message) => {
            setToast(message);
            refetch();
          }}
        />
      ))}
      {data.registered.length > 0 && (
        <Typography variant="body2" color="text.secondary">
          {REGISTERED_NOTE(data.registered.map((r) => r.name))}
        </Typography>
      )}
      <Snackbar
        open={toast !== null}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
        message={toast}
      />
    </Stack>
  );
}

/** The server operator's page; anyone else is told whose it is, and nothing is asked of the server. */
export default function ConnectorAppsPage() {
  const { isOperator } = useAuth();
  return (
    <Box>
      <Heading />
      {isOperator ? <ConnectorAppsList /> : <Alert severity="info">{ONLY_THE_OPERATOR}</Alert>}
    </Box>
  );
}
