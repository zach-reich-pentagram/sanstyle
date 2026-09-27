# export the latest checkpoint (net.pt) to letters-model.js + reference outputs
import json, sys, torch, numpy as np
from train import Net, export, load
net = Net(); net.load_state_dict(torch.load('net.pt')); net.eval()
export(net, sys.argv[1] if len(sys.argv) > 1 else 'letters-model.js')
Xva, yva = load('val.npz')
with torch.no_grad():
    xb = Xva[:8].float().unsqueeze(1) / 255.0
    ref = torch.softmax(net(xb), 1).numpy()
json.dump({'x': Xva[:8].numpy().reshape(8, -1).tolist(), 'p': ref.tolist()}, open('ref.json', 'w'))
print('ok')
