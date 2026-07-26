// Gerador automático de IDs para novos clientes
// Formatos suportados: timestamp-based, UUID v4, nanoid

export class CustomerIDGenerator {
  /**
   * Gera ID baseado em timestamp + aleatório
   * Formato: C-20240726-ABC123XYZ
   * Vantagem: legível, sequencial, fácil de debugar
   */
  static generateTimestampID() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const timestamp = date.getTime().toString(36).toUpperCase().slice(-4);
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `C-${year}${month}${day}-${timestamp}${random}`;
  }

  /**
   * Gera ID de formato seguro e compacto (nanoid-like)
   * Formato: C_9k8x7w6v5u4t3s2r1q
   * Vantagem: curto, url-safe, raro conflito
   */
  static generateNanoID(length = 18) {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let id = 'C_';
    for (let i = 0; i < length; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
  }

  /**
   * Gera UUID v4 (mais tradicional)
   * Formato: C-550e8400-e29b-41d4-a716-446655440000
   */
  static generateUUID() {
    const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
    return `C-${uuid}`;
  }

  /**
   * Gera ID customizado com prefixo (ex: para BitPanel)
   * Formato: GATE-2024-07-001234
   */
  static generateCustomPrefixID(prefix = 'GATE') {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const random = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
    return `${prefix}-${year}-${month}-${random}`;
  }

  /**
   * Valida se um ID gerado já existe no banco de dados
   * Retorna true se o ID é único
   */
  static async isIDUnique(id, database) {
    try {
      const result = await database.query(
        'SELECT id FROM customers WHERE bitpanel_list_id = $1 OR id = $1 LIMIT 1',
        [id]
      );
      return result.rows.length === 0;
    } catch (error) {
      console.error('Erro ao validar ID único:', error);
      return false;
    }
  }

  /**
   * Gera um ID garantidamente único (com retry)
   */
  static async generateUniqueID(database, format = 'nano', maxRetries = 5) {
    let attempts = 0;
    let id;

    while (attempts < maxRetries) {
      // Seleciona formato
      switch (format) {
        case 'timestamp':
          id = this.generateTimestampID();
          break;
        case 'uuid':
          id = this.generateUUID();
          break;
        case 'custom':
          id = this.generateCustomPrefixID();
          break;
        default:
          id = this.generateNanoID();
      }

      // Valida unicidade
      const isUnique = await this.isIDUnique(id, database);
      if (isUnique) {
        return { success: true, id, format, attempts };
      }

      attempts++;
    }

    return {
      success: false,
      error: 'Não foi possível gerar ID único após múltiplas tentativas',
      attempts: maxRetries
    };
  }

  /**
   * Sugere IDs alternativos (para caso de conflito)
   */
  static generateAlternatives(baseID, count = 3) {
    const alternatives = [];
    for (let i = 0; i < count; i++) {
      alternatives.push(this.generateNanoID());
    }
    return [baseID, ...alternatives];
  }
}

export default CustomerIDGenerator;
