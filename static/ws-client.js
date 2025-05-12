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

// Inicializar gráfico de conductividad
function initChart() {
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
}

// Función para actualizar gráfico con nuevos datos
function updateChart(conductivity) {
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
}

// Evaluar el estado de la conductividad
function evaluateConductivity(conductivity) {
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
    // Obtener valor de conductividad
    const conductivity = data.C;
    
    // Actualizar indicador
    document.getElementById('conductivity').textContent = conductivity.toFixed(0);
    
    // Evaluar estado y actualizar indicador
    const evaluation = evaluateConductivity(conductivity);
    const statusElement = document.getElementById('conductivityStatus');
    statusElement.textContent = evaluation.status;
    statusElement.className = `sensor-status ${evaluation.class}`;
    
    // Actualizar timestamp
    const now = new Date();
    document.getElementById('lastUpdate').textContent = 
        `Última actualización: ${now.toLocaleTimeString()}`;
    
    // Actualizar gráfico
    updateChart(conductivity);
}

// Conectar WebSocket
function connectWebSocket() {
    const statusElement = document.getElementById('connection');
    
    statusElement.textContent = 'Conectando...';
    
    // Usar protocolo wss:// para HTTPS, ws:// para HTTP
    const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    const ws = new WebSocket(`${protocol}${window.location.host}/ws`);
    
    ws.onopen = function() {
        statusElement.textContent = 'Conectado';
        statusElement.className = 'status connected';
        console.log('WebSocket conectado');
    };
    
    ws.onmessage = function(event) {
        const data = JSON.parse(event.data);
        console.log('Datos recibidos:', data);
        
        // Procesamos datos solo si tienen el campo C (conductividad)
        if (data.C !== undefined) {
            updateInterface(data);
        }
    };
    
    ws.onclose = function() {
        statusElement.textContent = 'Desconectado - Reconectando...';
        statusElement.className = 'status disconnected';
        // Reconectar después de 2 segundos
        setTimeout(connectWebSocket, 2000);
    };
    
    ws.onerror = function(err) {
        console.error('Error en WebSocket:', err);
        ws.close();
    };
}

// Inicializar cuando la página cargue
window.addEventListener('load', function() {
    // Inicializar gráfico
    initChart();
    
    // Conectar WebSocket
    connectWebSocket();

    // Manejar el redimensionamiento de la ventana
    window.addEventListener('resize', function() {
        Plotly.Plots.resize('conductivityChart');
    });
});