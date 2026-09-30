import React, { createContext, useContext, useEffect, useState } from 'react';
import { DEFAULT_SERVERS, ServerConfig, loadServers, saveServers } from './config';

const Ctx = createContext<ServerConfig & { update(s: ServerConfig): Promise<void>; ready: boolean }>({ ...DEFAULT_SERVERS, update: async () => {}, ready: false });

export function ServersProvider({ children }: { children: React.ReactNode }) {
  const [s, setS] = useState<ServerConfig>(DEFAULT_SERVERS);
  const [ready, setReady] = useState(false);
  useEffect(() => { loadServers().then((v) => { setS(v); setReady(true); }); }, []);
  const update = async (v: ServerConfig) => { await saveServers(v); setS(v); };
  return <Ctx.Provider value={{ ...s, update, ready }}>{children}</Ctx.Provider>;
}
export const useServers = () => useContext(Ctx);
