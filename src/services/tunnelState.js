let state = {
  ngrokUrl: null,
  connectUrl: null,
  ready: false,
};

export function getTunnelState() {
  return { ...state };
}

export function setTunnelState(partial) {
  state = { ...state, ...partial };
}
