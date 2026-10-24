// Public instructions only. Customer credentials and private playlist URLs do
// not belong in this catalogue. Sources were checked on the date below.
export const CLIENT_HELP_VERIFIED_AT = '2026-10-12T21:15:22.000Z';

const ssIptv = {
  name:'SS IPTV',url:'https://ss-iptv.com/en/users/documents/installing',
  sourceUrl:'https://ss-iptv.com/en/users/documents/how-to-upload-playlist',protocols:['m3u'],requiredFields:['playlistUrl'],
  requirements:[
    'Este aplicativo usa uma lista M3U completa. O endereço DNS sozinho não é uma lista. Abra o guia do aplicativo nesta área e toque em Mostrar lista para copiar a URL do seu próprio acesso.',
    'A URL da lista contém sua senha de acesso e fica visível por 60 segundos. Use somente no aplicativo ou site oficial e não compartilhe. Se não estiver disponível, aguarde a atualização ou fale com a equipe.',
    'Como alternativa, o editor oficial aceita o código de conexão gerado em Geral. Ele vale 24 horas ou até gerar outro código.'
  ],
  stepsSupport:[
    'Abra SS IPTV e entre em Configurações, Conteúdo e Listas externas.',
    'Escolha Adicionar. Dê um nome à lista e preencha o campo de endereço com a URL M3U copiada pelo botão Mostrar lista deste guia.',
    'Salve e abra o novo bloco da lista na tela inicial para testar.',
    'Para trocar a URL ou acompanhar uma mudança de DNS, copie a nova URL M3U pelo botão Mostrar lista e adicione outra lista com nome diferente. Teste antes de remover a anterior.',
    'Se usar o editor pelo código, obtenha o código em Configurações, Geral e Get code. No editor oficial, adicione o dispositivo e envie o arquivo M3U. Uma nova lista interna substitui a antiga.'
  ]
};

const smartOne = {
  name:'SmartOne IPTV',url:'https://smartone-iptv.com/',
  sourceUrl:'https://smartone-iptv.com/plugin/support_manager/knowledgebase/view/34/how-do-you-distinguish-between-normal-playlist-and/5/',
  protocols:['xtream','m3u'],requiredFields:['mac','username','password','dns','playlistUrl'],availability:'supported',
  requirements:[
    'Confira o MAC mostrado dentro do SmartOne. Ele identifica o aparelho no gerenciamento de listas.',
    'Para Xtream, use os dados de Meu acesso. Se o formulário separar endereço e porta, confirme a porta com a equipe.',
    'A opção M3U exige a URL completa da sua lista. Neste guia, toque em Mostrar lista para copiar a URL própria atual. A licença do player é separada da assinatura.',
    'A URL da lista contém sua senha de acesso e fica visível por 60 segundos. Use somente no aplicativo ou site oficial e não compartilhe. Se não estiver disponível, aguarde a atualização ou fale com a equipe.'
  ],
  stepsSupport:[
    'Procure SmartOne IPTV na loja da TV e confira o desenvolvedor antes de instalar.',
    'Abra o gerenciamento de playlists pelo site oficial do SmartOne e informe o MAC exibido no aplicativo.',
    'Na opção Xtream Server Info, dê um nome à conta e preencha endereço do servidor, usuário e senha com os dados atuais de Meu acesso.',
    'Para atualizar a DNS, cadastre uma nova conta com o endereço atual e os mesmos dados de acesso confirmados. Salve e teste essa conta na TV antes de remover a antiga.',
    'Se preferir a opção M3U, copie a URL completa atual pelo botão Mostrar lista deste guia e preencha o campo de playlist. Nunca substitua uma lista completa apenas pela DNS.'
  ]
};

const smarters = {
  name:'IPTV Smarters Pro / SMARTERS PRO',url:'https://smarterspro.com/',
  sourceUrl:'https://smarterspro.com/how-to-use-smarters-pro-on-android-iphone-smart-tvs-web-browsers/',
  protocols:['xtream','m3u'],requiredFields:['username','password','dns','playlistUrl'],availability:'supported',
  requirements:[
    'A instalação Samsung atual é SMARTERS PRO, do desenvolvedor TECH SMARTERS PRIVATE LIMITED. A página oficial informa LG como Coming Soon.',
    'Menus e formas de login variam entre versões. Use Xtream/API quando essa opção estiver disponível. Se usar M3U, copie a URL completa atual pelo botão Mostrar lista deste guia.',
    'A URL da lista contém sua senha de acesso e fica visível por 60 segundos. Use somente no aplicativo ou site oficial e não compartilhe. Se não estiver disponível, aguarde a atualização ou fale com a equipe.'
  ],
  stepsSupport:[
    'Na Samsung, pressione Home, abra Apps, pesquise SMARTERS PRO e confira o desenvolvedor. Instale e abra.',
    'Na tela de adicionar lista ou perfil, escolha Xtream/API quando disponível. Dê um nome ao perfil e informe usuário, senha e endereço do servidor de Meu acesso nos campos correspondentes.',
    'Para mudar a URL do servidor, use a edição do perfil se a versão oferecer essa opção. Caso não ofereça, adicione outro perfil com a DNS atual e os dados confirmados.',
    'Abra o perfil atualizado e teste a reprodução. Mantenha o perfil anterior até confirmar que o novo funciona.',
    'Se a tela exigir playlist M3U, use a URL própria copiada pelo botão Mostrar lista. Se exigir outro dado, peça à equipe a informação exata para essa versão; não monte uma URL com sua senha.'
  ]
};

const ibo = {
  name:'IBO Player',url:'https://iboplayer.com/',sourceUrl:'https://frontend.iboplayer.com/news',
  protocols:['m3u'],requiredFields:['mac','deviceKey','playlistUrl'],availability:'model_check_required',
  requirements:[
    'Confirme que o aplicativo é IBO Player e confira o site exibido na própria tela; existem variantes com nomes semelhantes.',
    'O gerenciamento usa o MAC e a chave do dispositivo mostrados pelo app, além da URL M3U completa copiada pelo botão Mostrar lista deste guia. A DNS sozinha não substitui a lista.',
    'A URL da lista contém sua senha de acesso e fica visível por 60 segundos. Use somente no aplicativo ou site oficial e não compartilhe. Se não estiver disponível, aguarde a atualização ou fale com a equipe.'
  ],
  stepsSupport:[
    'Na loja Samsung ou LG, confira IBO Player e a compatibilidade com o seu modelo antes de instalar.',
    'Abra o app e anote o MAC e a chave do dispositivo. Use o gerenciamento indicado pelo próprio aplicativo.',
    'Entre no gerenciamento com o MAC e a chave. Adicione a URL M3U atual do seu próprio acesso.',
    'Para uma mudança de URL ou DNS, copie a lista completa atualizada pelo botão Mostrar lista e adicione uma nova playlist. Reinicie o app e teste a lista nova.',
    'Depois de confirmar a reprodução, decida se deseja remover a lista anterior. Não use a função de reset para uma simples atualização, pois ela remove as listas existentes.'
  ]
};

const entries = [
  {...ssIptv,id:'ss-iptv-lg',device:'LG',availability:'supported',requirements:[...ssIptv.requirements,
    'A instalação oficial LG é pela LG Smart World/loja de aplicativos. Confirme disponibilidade no seu modelo e região.']},
  {...ssIptv,id:'ss-iptv-samsung',device:'Samsung',availability:'model_check_required',requirements:[...ssIptv.requirements,
    'O guia atual informa SS IPTV fora do Smart Hub Samsung e descreve USB apenas para modelos de 2012 a 2019. Se já estiver instalado, siga a configuração; para instalar, a equipe deve conferir o modelo primeiro.']},
  {...smarters,id:'iptv-smarters-pro-samsung',device:'Samsung'},
  ...['Samsung','LG'].map(device=>({...smartOne,id:`smartone-iptv-${device.toLowerCase()}`,device})),
  ...['Samsung','LG'].map(device=>({...ibo,id:`ibo-player-${device.toLowerCase()}`,device}))
];

export function getClientHelpApps() {
  return entries.map(app=>({...app,verifiedAt:CLIENT_HELP_VERIFIED_AT,protocols:[...app.protocols],
    requiredFields:[...app.requiredFields],requirements:[...app.requirements],stepsSupport:[...app.stepsSupport]}));
}
