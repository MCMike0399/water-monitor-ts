// Configuración para almacenar historial de datos
const MAX_DATA_POINTS = 50;
const chartData = {
    time: [],
    conductivity: []
};

// Umbrales para alertas de conductividad
const CONDUCTIVITY_THRESHOLDS = {
    ideal: { max: 300 },
    good: { max: 600 },
    acceptable: { max: 900 },
    warning: { max: 1200 },
    danger: { max: 1400 }
};

// Función de logging
function log(level, message, data) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${message}`);
    if (data) console.log(data);
}

// Inicializar gráfico de conductividad
function initChart() {
    log('INFO', 'Initializing conductivity chart');
    try {
        const conductivityTrace = {
            x: chartData.time,
            y: chartData.conductivity,
            name: 'Conductividad',
            type: 'scatter',
            line: {color: '#2ecc71', width: 2}
        };

        const layout = {
            title: 'Conductividad en Tiempo Real',
            margin: { l: 60, r: 20, t: 50, b: 80 },
            xaxis: {
                title: { text: 'Tiempo' },
                showgrid: true
            },
            yaxis: {
                title: 'Conductividad (μS/cm)',
                titlefont: {color: '#2ecc71'},
                tickfont: {color: '#2ecc71'},
                range: [0, 1500]
            }
        };

        Plotly.newPlot('conductivityChart', [conductivityTrace], layout, {responsive: true});
        log('INFO', 'Chart initialization successful');
    } catch (error) {
        log('ERROR', 'Failed to initialize chart', error);
    }
}

// Función para actualizar gráfico con nuevos datos
function updateChart(conductivity) {
    log('DEBUG', `Updating chart with conductivity: ${conductivity}`);
    try {
        const now = new Date();
        const timeStr = now.toLocaleTimeString();
        
        // Añadir nuevo punto de datos
        chartData.time.push(timeStr);
        chartData.conductivity.push(conductivity);
        
        // Limitar el número de puntos
        if (chartData.time.length > MAX_DATA_POINTS) {
            chartData.time.shift();
            chartData.conductivity.shift();
        }
        
        // Actualizar gráfico
        Plotly.update('conductivityChart', {
            x: [chartData.time],
            y: [chartData.conductivity]
        }, {}, [0]);
        log('DEBUG', 'Chart updated successfully');
    } catch (error) {
        log('ERROR', 'Failed to update chart', error);
    }
}

// Evaluar el estado de la conductividad
function evaluateConductivity(conductivity) {
    log('DEBUG', `Evaluating conductivity: ${conductivity}`);
    const value = parseFloat(conductivity);
    
    if (value <= CONDUCTIVITY_THRESHOLDS.ideal.max) {
        return {
            status: "Excelente - Agua muy pura",
            class: "alert-success"
        };
    } else if (value <= CONDUCTIVITY_THRESHOLDS.good.max) {
        return {
            status: "Buena calidad - Rango normal",
            class: "alert-success"
        };
    } else if (value <= CONDUCTIVITY_THRESHOLDS.acceptable.max) {
        return {
            status: "Aceptable - Monitorear",
            class: "alert-info"
        };
    } else if (value <= CONDUCTIVITY_THRESHOLDS.warning.max) {
        return {
            status: "Advertencia: Conductividad elevada",
            class: "alert-warning"
        };
    } else {
        return {
            status: "PELIGRO: Conductividad muy alta",
            class: "alert-danger"
        };
    }
}

// Actualizar interfaz con nuevos valores
function updateInterface(data) {
    log('INFO', 'Updating interface with new data', data);
    try {
        // Obtener valor de conductividad
        const conductivity = data.C;
        
        if (conductivity === undefined || conductivity === null) {
            log('WARN', 'Invalid conductivity value received', data);
            return;
        }
        
        // Actualizar indicador
        document.getElementById('conductivity').textContent = conductivity.toFixed(0);
        
        // Evaluar estado y actualizar indicador
        const evaluation = evaluateConductivity(conductivity);
        log('DEBUG', 'Conductivity evaluation', evaluation);
        
        const statusElement = document.getElementById('conductivityStatus');
        statusElement.textContent = evaluation.status;
        statusElement.className = `sensor-status ${evaluation.class}`;
        
        // Actualizar timestamp
        const now = new Date();
        document.getElementById('lastUpdate').textContent = 
            `Última actualización: ${now.toLocaleTimeString()}`;
        
        // Actualizar gráfico
        updateChart(conductivity);
    } catch (error) {
        log('ERROR', 'Failed to update interface', error);
    }
}

// Conectar WebSocket
function connectWebSocket() {
    const statusElement = document.getElementById('connection');
    
    statusElement.textContent = 'Conectando...';
    log('INFO', 'Initiating WebSocket connection');
    
    // Usar protocolo wss:// para HTTPS, ws:// para HTTP
    const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    const wsUrl = `${protocol}${window.location.host}/ws`;
    log('INFO', `Connecting to WebSocket: ${wsUrl}`);
    
    try {
        const ws = new WebSocket(wsUrl);
        
        ws.onopen = function() {
            log('INFO', 'WebSocket connection established');
            statusElement.textContent = 'Conectado';
            statusElement.className = 'status connected';
        };
        
        ws.onmessage = function(event) {
            log('DEBUG', 'Raw WebSocket message received', { data: event.data });
            try {
                const data = JSON.parse(event.data);
                log('INFO', 'Parsed WebSocket data', data);
                
                // Procesamos datos solo si tienen el campo C (conductividad)
                if (data.C !== undefined) {
                    updateInterface(data);
                } else {
                    log('WARN', 'Received data missing conductivity value', data);
                }
            } catch (error) {
                log('ERROR', 'Failed to parse WebSocket message', error);
            }
        };
        
        ws.onclose = function(event) {
            log('WARN', 'WebSocket connection closed', {
                code: event.code,
                reason: event.reason,
                wasClean: event.wasClean
            });
            
            statusElement.textContent = 'Desconectado - Reconectando...';
            statusElement.className = 'status disconnected';
            
            // Reconectar después de 2 segundos
            setTimeout(connectWebSocket, 2000);
        };
        
        ws.onerror = function(event) {
            log('ERROR', 'WebSocket error occurred', event);
            // Add this for browser environments that don't expose error details
            console.log('WebSocket error:', event);
            try {
                ws.close();
            } catch (closeError) {
                log('ERROR', 'Error closing WebSocket after error', closeError);
            }
        };
    } catch (error) {
        log('ERROR', 'Failed to create WebSocket connection', error);
        statusElement.textContent = 'Error de conexión';
        statusElement.className = 'status disconnected';
        setTimeout(connectWebSocket, 5000);
    }
}

// Inicializar cuando la página cargue
window.addEventListener('load', function() {
    log('INFO', 'Page loaded, initializing application');
    
    try {
        // Inicializar gráfico
        initChart();
        
        // Conectar WebSocket
        connectWebSocket();

        // Manejar el redimensionamiento de la ventana
        window.addEventListener('resize', function() {
            log('DEBUG', 'Window resize detected, resizing chart');
            try {
                Plotly.Plots.resize('conductivityChart');
            } catch (error) {
                log('ERROR', 'Failed to resize chart', error);
            }
        });
        
        log('INFO', 'Application initialization complete');
    } catch (error) {
        log('ERROR', 'Failed to initialize application', error);
    }
});