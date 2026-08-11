import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { AppButton, AppSelect, InfoTip } from '../../src/ui/components';
import { apiClient } from '../../utils/api';
import { envFromServer } from './utils';
import {
  parseRustParams,
  serializeRustParams,
  type RustLaunchParams,
  RUST_GAMEMODE_OPTIONS,
  RUST_WORLDSIZE_MIN,
  RUST_WORLDSIZE_MAX,
  RUST_SEED_MIN,
  RUST_SEED_MAX,
} from '../../utils/rustParams';

interface RustLaunchParamsSectionProps {
  serverId: number;
  canEdit: boolean;
  borderColor: string;
  contentBg: string;
  textPrimary: string;
  textSecondary: string;
}

// Section B — pooled launch convars in RUST_START_PARAMS. Saving edits the env and
// recreates the container (env-edit → recreate → restart), like CS2 handles its
// pooled start params. Values are space-free and written without quotes.
export function RustLaunchParamsSection({
  serverId,
  canEdit,
  borderColor,
  contentBg,
  textPrimary,
  textSecondary,
}: RustLaunchParamsSectionProps) {
  const [env, setEnv] = useState<Record<string, string> | null>(null);
  const [params, setParams] = useState<RustLaunchParams>({ worldsize: '', seed: '', gamemode: '', extra: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const loaded = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const server = await apiClient.getServer(serverId);
      const parsedEnv = envFromServer(server);
      setEnv(parsedEnv);
      setParams(parseRustParams(parsedEnv['RUST_START_PARAMS'] ?? ''));
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load launch parameters.');
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void load();
  }, [load]);

  const patch = (next: Partial<RustLaunchParams>) => setParams((prev) => ({ ...prev, ...next }));

  const handleSave = async () => {
    if (!canEdit || saving || !env) return;
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const newEnv = { ...env, RUST_START_PARAMS: serializeRustParams(params) };
      await apiClient.updateServer(serverId, { env: newEnv });
      setEnv(newEnv);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to save launch parameters.');
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    'w-full rounded-lg bg-white dark:bg-[#0f1723]/60 border border-gray-300 dark:border-gray-700/50 text-gray-900 dark:text-white text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--gp-ods-accent-primary)] dark:focus:ring-white/20 focus:border-transparent disabled:opacity-50 transition-all';

  return (
    <div className={`${contentBg} border ${borderColor} rounded-lg p-4 space-y-3`}>
      <div className="flex items-center gap-1.5">
        <h4 className={`text-base font-semibold ${textPrimary}`}>Launch parameters</h4>
        <InfoTip text="Creation-time convars — saving recreates the container and restarts the server. World size & seed only apply to the first map generation (changing them later needs a wipe); changing the game mode resets all players and their inventories." />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading launch parameters…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={`mb-1 block text-xs ${textSecondary}`}>World size</label>
              <input
                type="number"
                min={RUST_WORLDSIZE_MIN}
                max={RUST_WORLDSIZE_MAX}
                value={params.worldsize}
                onChange={(e) => patch({ worldsize: e.target.value })}
                disabled={!canEdit}
                placeholder={`${RUST_WORLDSIZE_MIN}–${RUST_WORLDSIZE_MAX} (default 4000)`}
                className={inputCls}
              />
            </div>
            <div>
              <label className={`mb-1 block text-xs ${textSecondary}`}>Seed</label>
              <input
                type="number"
                min={RUST_SEED_MIN}
                max={RUST_SEED_MAX}
                value={params.seed}
                onChange={(e) => patch({ seed: e.target.value })}
                disabled={!canEdit}
                placeholder="0 = random"
                className={inputCls}
              />
            </div>
          </div>

          <div>
            <label className={`mb-1 block text-xs ${textSecondary}`}>Game mode</label>
            <AppSelect
              className="gp-game-config-select"
              value={params.gamemode}
              onChange={(v) => patch({ gamemode: v })}
              options={RUST_GAMEMODE_OPTIONS}
              disabled={!canEdit}
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}
          {success && (
            <p className="flex items-center gap-1.5 text-sm text-emerald-400">
              <Save className="h-4 w-4" /> Saved. The server was recreated with the new parameters.
            </p>
          )}

          {canEdit && (
            <div className="flex justify-end">
              <AppButton
                tone="primary"
                onClick={() => void handleSave()}
                disabled={saving}
                className="flex items-center gap-1.5 rounded-lg px-5 py-2.5 text-sm font-medium disabled:opacity-60"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                {saving ? 'Saving…' : 'Save'}
              </AppButton>
            </div>
          )}
        </>
      )}
    </div>
  );
}
