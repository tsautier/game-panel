import { useState } from 'react';
import { apiClient } from '../../utils/api';
import { GameSettingsSection } from './GameSettingsSection';
import { RustLaunchParamsSection } from './RustLaunchParamsSection';
import { RustFrameworkSection } from './RustFrameworkSection';
import { ModsSection } from './ModsSection';
import { ServerEnvFieldsCard, type EnvFieldDef } from './ServerEnvFieldsCard';
import { GameWipeTab } from './GameWipeTab';
import { buildWipeModes } from './wipeModes';

// Steam games expose an "Update on start" toggle (SteamCMD auto-update each boot).
const ENV_FIELDS: EnvFieldDef[] = [
  {
    key: 'RUST_UPDATE_ON_START',
    label: 'Update on start',
    type: 'toggle',
    defaultValue: 'false',
    description: 'When enabled, the server checks for and installs game updates via SteamCMD each time it starts.',
  },
];

// RCON password, editable after install. Backed by an env var, so saving recreates
// the container and restarts the server.
const RCON_FIELDS: EnvFieldDef[] = [
  {
    key: 'RUST_RCON_PASSWORD',
    label: 'RCON password',
    type: 'password',
    minLength: 8,
  },
];

export interface RustSectionsProps {
  serverId: number;
  serverStatus?: string | null;
  canReadSettings: boolean;
  canWriteSettings: boolean;
  canReadMods: boolean;
  canWriteMods: boolean;
  canWriteFrameworks: boolean;
  canWipeSoft?: boolean;
  canWipeHard?: boolean;
  onReinstallStarted?: () => void;
  canManageEnv?: boolean;
  canEditContainerConfig?: boolean;
  containerConfigSaveCount?: number;
  advancedLinksNode?: React.ReactNode;
  borderColor: string;
  contentBg: string;
  textPrimary: string;
  textSecondary: string;
}

type RustSubTab = 'settings' | 'oxide' | 'wipe';

// Rust reuses the OVHcloud generic building blocks: file-settings (server.cfg) and
// pooled launch params on the Settings tab, an Oxide framework + plugins area, and the
// generic wipe. Mirrors the Project Zomboid sub-tab scaffold.
export function RustSections({
  serverId,
  serverStatus,
  canReadSettings,
  canWriteSettings,
  canReadMods,
  canWriteMods,
  canWriteFrameworks,
  canWipeSoft,
  canWipeHard,
  onReinstallStarted,
  canManageEnv,
  canEditContainerConfig,
  containerConfigSaveCount,
  advancedLinksNode,
  borderColor,
  contentBg,
  textPrimary,
  textSecondary,
}: RustSectionsProps) {
  const canEditLaunchParams = Boolean(canManageEnv && canEditContainerConfig);
  // The Settings tab holds server.cfg convars (Section A), the pooled launch
  // parameters (Section B) and the env-backed controls. Show it if the user can
  // see any of them.
  const showSettingsTab = canReadSettings || Boolean(canManageEnv);
  // The Oxide tab holds the framework installer plus (once installed) the plugins area.
  const showOxideTab = canWriteFrameworks || canReadMods;

  const showWipeTab = buildWipeModes('rust', {
    canSoft: Boolean(canWipeSoft),
    canHard: Boolean(canWipeHard),
  }).length > 0;

  const tabs: { id: RustSubTab; label: string }[] = [
    showSettingsTab && { id: 'settings', label: 'Server Settings' },
    showOxideTab && { id: 'oxide', label: 'Mods' },
    showWipeTab && { id: 'wipe', label: 'Wipe' },
  ].filter(Boolean) as { id: RustSubTab; label: string }[];

  const firstTab = tabs[0]?.id ?? 'settings';
  const [activeTab, setActiveTab] = useState<RustSubTab>(firstTab);
  const [visited, setVisited] = useState<Set<RustSubTab>>(() => new Set([firstTab]));
  // Oxide gates the plugins area; the framework section reports its status up here.
  const [oxideInstalled, setOxideInstalled] = useState(false);

  const switchTab = (id: RustSubTab) => {
    setActiveTab(id);
    setVisited((prev) => new Set([...prev, id]));
  };

  if (tabs.length === 0) return null;

  return (
    <div>
      {tabs.length > 1 && (
        <div className={`flex flex-wrap border-b ${borderColor} mb-3 gap-0`}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => switchTab(tab.id)}
              className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
                activeTab === tab.id
                  ? 'border-[var(--color-cyan-400)] text-white'
                  : 'border-transparent text-gray-400 hover:text-white hover:border-gray-500'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {visited.has('settings') && showSettingsTab && (
        <div className={`space-y-4 ${activeTab !== 'settings' ? 'hidden' : ''}`}>
          {canReadSettings && (
            <GameSettingsSection
              serverId={serverId}
              serverStatus={serverStatus}
              canRead={canReadSettings}
              canWrite={canWriteSettings}
              load={(id) => apiClient.getRustSettings(id)}
              save={(id, changed) => apiClient.patchRustSettings(id, changed)}
              borderColor={borderColor}
              contentBg={contentBg}
              textPrimary={textPrimary}
              textSecondary={textSecondary}
            />
          )}
          {canEditLaunchParams && (
            <RustLaunchParamsSection
              serverId={serverId}
              canEdit={canEditLaunchParams}
              borderColor={borderColor}
              contentBg={contentBg}
              textPrimary={textPrimary}
              textSecondary={textSecondary}
            />
          )}
          {canManageEnv && (
            <ServerEnvFieldsCard
              serverId={serverId}
              serverStatus={serverStatus}
              fields={RCON_FIELDS}
              canEdit={Boolean(canManageEnv && canEditContainerConfig)}
              containerConfigSaveCount={containerConfigSaveCount}
              title="RCON"
              borderColor={borderColor}
              contentBg={contentBg}
              textPrimary={textPrimary}
            />
          )}
          {canManageEnv && (
            <ServerEnvFieldsCard
              serverId={serverId}
              serverStatus={serverStatus}
              fields={ENV_FIELDS}
              canEdit={Boolean(canManageEnv && canEditContainerConfig)}
              containerConfigSaveCount={containerConfigSaveCount}
              title="Updates"
              borderColor={borderColor}
              contentBg={contentBg}
              textPrimary={textPrimary}
            />
          )}
          {advancedLinksNode && <div>{advancedLinksNode}</div>}
        </div>
      )}

      {visited.has('oxide') && showOxideTab && (
        <div className={`space-y-4 ${activeTab !== 'oxide' ? 'hidden' : ''}`}>
          {canWriteFrameworks && (
            <RustFrameworkSection
              serverId={serverId}
              serverStatus={serverStatus}
              canWrite={canWriteFrameworks}
              onInstalledChange={setOxideInstalled}
              borderColor={borderColor}
              contentBg={contentBg}
              textPrimary={textPrimary}
              textSecondary={textSecondary}
            />
          )}
          {canReadMods && (
            oxideInstalled ? (
              <ModsSection
                serverId={serverId}
                serverStatus={serverStatus}
                kind="mods"
                apiKind="rust"
                canRead={canReadMods}
                canWrite={canWriteMods}
                borderColor={borderColor}
                contentBg={contentBg}
                textPrimary={textPrimary}
                textSecondary={textSecondary}
              />
            ) : (
              <div className={`${contentBg} border ${borderColor} rounded-lg p-4 text-sm ${textSecondary}`}>
                Install Oxide to manage plugins for this server.
              </div>
            )
          )}
        </div>
      )}

      {visited.has('wipe') && showWipeTab && (
        <div className={activeTab !== 'wipe' ? 'hidden' : ''}>
          <GameWipeTab
            family="rust"
            serverId={serverId}
            serverStatus={serverStatus}
            canWipeSoft={Boolean(canWipeSoft)}
            canWipeHard={Boolean(canWipeHard)}
            onReinstallStarted={onReinstallStarted}
            borderColor={borderColor}
            contentBg={contentBg}
            textPrimary={textPrimary}
            textSecondary={textSecondary}
          />
        </div>
      )}
    </div>
  );
}
