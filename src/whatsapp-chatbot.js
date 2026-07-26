// Chatbot WhatsApp com IA — integração com OpenAI para atendimento inteligente
import OpenAI from 'openai';

export class WhatsAppChatbot {
  constructor(options = {}) {
    this.openai = new OpenAI({
      apiKey: options.openaiKey || process.env.OPENAI_API_KEY,
    });
    this.model = options.model || 'gpt-4o-mini';
    this.conversationHistory = new Map();
    this.maxHistoryMessages = 10;
    this.responseTimeout = 30000; // 30 segundos
  }

  /**
   * Gera uma resposta de IA para uma mensagem no WhatsApp
   * Mantém histórico de conversa por usuário
   */
  async generateAIResponse(userId, userMessage, context = {}) {
    try {
      // Recupera ou inicializa o histórico de conversa
      if (!this.conversationHistory.has(userId)) {
        this.conversationHistory.set(userId, []);
      }

      const history = this.conversationHistory.get(userId);

      // Limita o histórico para evitar contexto muito grande
      if (history.length > this.maxHistoryMessages) {
        history.shift(); // Remove a mensagem mais antiga
      }

      // Constrói o sistema de instruções
      const systemPrompt = this.buildSystemPrompt(context);

      // Adiciona a mensagem do usuário ao histórico
      history.push({ role: 'user', content: userMessage });

      // Chama a OpenAI com histórico
      const response = await Promise.race([
        this.openai.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...history
          ],
          temperature: 0.7,
          max_tokens: 1000,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout na IA')), this.responseTimeout)
        )
      ]);

      const assistantMessage = response.choices[0].message.content;

      // Adiciona a resposta da IA ao histórico
      history.push({ role: 'assistant', content: assistantMessage });

      return {
        success: true,
        message: assistantMessage,
        usage: {
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens
        }
      };
    } catch (error) {
      console.error('Erro ao gerar resposta de IA:', error);
      return {
        success: false,
        message: 'Desculpe, estou tendo dificuldades no momento. Por favor, tente novamente.',
        error: error.message
      };
    }
  }

  /**
   * Constrói o prompt do sistema com contexto do cliente
   */
  buildSystemPrompt(context = {}) {
    const { customerName, planName, expiresOn, status, businessName } = context;

    return `Você é um assistente de atendimento ao cliente para ${businessName || 'Gate One Pro Server'}.

Seu objetivo é:
1. Responder dúvidas sobre planos e assinaturas de forma clara e amigável
2. Fornecer informações sobre vencimentos e renovações
3. Oferecer suporte inicial a problemas técnicos
4. Encaminhar para atendimento humano quando necessário
5. Usar linguagem casual e amigável

${customerName ? `Cliente: ${customerName}` : ''}
${planName ? `Plano atual: ${planName}` : ''}
${expiresOn ? `Vencimento: ${new Date(expiresOn).toLocaleDateString('pt-BR')}` : ''}
${status ? `Status: ${status}` : ''}

Regras importantes:
- NUNCA aprove pagamentos ou execute transações financeiras
- NUNCA altere dados de cliente ou renovações
- Sempre seja honesto se não souber algo
- Se o cliente pedir suporte técnico complexo ou financeiro, sugira contato com nosso time

Mantenha as respostas curtas (até 3 linhas) e use emojis quando apropriado para WhatsApp.`;
  }

  /**
   * Limpa o histórico de conversa de um usuário
   */
  clearHistory(userId) {
    this.conversationHistory.delete(userId);
  }

  /**
   * Processa mensagens recebidas do WhatsApp
   */
  async processWhatsAppMessage(phoneNumber, message, customer = null) {
    // Detecta palavras-chave para roteamento automático
    const lowerMessage = message.toLowerCase();

    // Palavras-chave para encaminhamento automático
    if (this.shouldEscalateToHuman(lowerMessage)) {
      return {
        type: 'escalate',
        message: '🔗 Vou conectar você com nosso time de atendimento. Um momento...',
        action: 'transfer_to_human'
      };
    }

    // Gera resposta de IA
    const context = customer ? {
      customerName: customer.name,
      planName: customer.plan_name,
      expiresOn: customer.expires_on,
      status: customer.status,
      businessName: 'Gate One Pro'
    } : {};

    const aiResponse = await this.generateAIResponse(phoneNumber, message, context);

    if (!aiResponse.success) {
      return {
        type: 'error',
        message: aiResponse.message,
        action: 'escalate'
      };
    }

    return {
      type: 'ai_response',
      message: aiResponse.message,
      metadata: aiResponse.usage
    };
  }

  /**
   * Determina se a mensagem deve ser escalada para atendimento humano
   */
  shouldEscalateToHuman(message) {
    const escalationKeywords = [
      'humano',
      'pessoa',
      'falar com',
      'atendente',
      'suporte',
      'problema técnico',
      'urgente',
      'já tentei',
      'não funcionou',
      'error',
      'não consigo',
      'como faço',
      'onde',
      'quando',
      'quanto custa'
    ];

    return escalationKeywords.some(keyword => message.includes(keyword));
  }

  /**
   * Gera sugestões automáticas baseadas no contexto
   */
  generateSuggestions(context = {}) {
    const suggestions = [];

    if (context.status === 'active' && context.expiresOn) {
      const daysUntilExpiry = Math.ceil((new Date(context.expiresOn) - new Date()) / (1000 * 60 * 60 * 24));
      if (daysUntilExpiry <= 7) {
        suggestions.push('Renovar meu plano');
      }
    }

    suggestions.push('Qual é meu plano?');
    suggestions.push('Como faço para renovar?');
    suggestions.push('Preciso de suporte');

    return suggestions;
  }
}

export default WhatsAppChatbot;
